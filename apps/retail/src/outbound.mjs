// Everything retail says to the outside world: the pharmacy call (plain or
// SigV4-signed), the SQS check request, and the EventBridge audit event.
import { Sha256 } from '@aws-crypto/sha256-js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { logEvent } from './log.mjs';

const CALL_TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS || 5000);

let sqsClient = null;
let eventsClient = null;
let signer = null;

/** The region is whatever the environment says. Nothing here names one. */
function region() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function clientConfig() {
  const config = {};
  // Left unset the SDK resolves the region itself, from the environment or the
  // shared config file. Setting it to a literal would override that.
  const configured = region();
  if (configured) config.region = configured;
  if (process.env.AWS_ENDPOINT_URL) config.endpoint = process.env.AWS_ENDPOINT_URL;
  return config;
}

function getSqs() {
  if (!sqsClient) sqsClient = new SQSClient(clientConfig());
  return sqsClient;
}

function getEvents() {
  if (!eventsClient) eventsClient = new EventBridgeClient(clientConfig());
  return eventsClient;
}

/** Queues win over HTTP when CHECK_REQUEST_QUEUE_URL is set. That is the whole mode switch. */
export function usesQueues() {
  return Boolean(process.env.CHECK_REQUEST_QUEUE_URL);
}

/** Architecture C signs outbound calls as the caller's role. */
export function signsRequests() {
  return process.env.SIGN_REQUESTS === 'true';
}

function getSigner() {
  if (!signer) {
    const signingRegion = region();
    if (!signingRegion) {
      throw new Error('SIGN_REQUESTS is true but neither AWS_REGION nor AWS_DEFAULT_REGION is set');
    }
    signer = new SignatureV4({
      service: 'execute-api',
      region: signingRegion,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }
  return signer;
}

/**
 * Architectures A and C. Returns { valid, reason }. Throws when pharmacy is
 * unreachable or answers with a non-2xx, so the caller can leave the order pending.
 */
export async function fetchCheck({ prescriptionId, customerId, sku, correlationId }) {
  const base = process.env.PHARMACY_BASE_URL;
  if (!base) throw new Error('PHARMACY_BASE_URL is not set');
  const url = new URL(`${base.replace(/\/$/, '')}/prescriptions/${encodeURIComponent(prescriptionId)}/check`);
  url.searchParams.set('customerId', customerId);
  url.searchParams.set('sku', sku);

  const headers = { accept: 'application/json', 'x-correlation-id': correlationId };
  const requestInit = { method: 'GET', headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
  if (signsRequests()) requestInit.headers = await signGet(url, headers);

  const response = await fetch(url, requestInit);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`pharmacy check failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text);
  return { valid: Boolean(parsed.valid), reason: parsed.reason ?? null };
}

/** SigV4 for a GET. Returns the header set to send, signature included. */
async function signGet(url, headers) {
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const request = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    method: 'GET',
    path: url.pathname,
    query,
    headers: { ...headers, host: url.host },
  });
  const signed = await getSigner().sign(request);
  return signed.headers;
}

/** Architecture B. Asks pharmacy for a check over SQS. */
export async function sendCheckRequest({ orderId, prescriptionId, customerId, sku, correlationId }) {
  const queueUrl = process.env.CHECK_REQUEST_QUEUE_URL;
  if (!queueUrl) throw new Error('CHECK_REQUEST_QUEUE_URL is not set');
  const message = {
    type: 'PrescriptionCheckRequested',
    orderId,
    prescriptionId,
    customerId,
    sku,
    idempotencyKey: orderId,
  };
  await getSqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        correlationId: { DataType: 'String', StringValue: correlationId },
      },
    }),
  );
  logEvent('info', 'check requested', { correlationId, orderId, queueUrl });
}

/**
 * Architecture C audit trail. A failure here does not fail the order, so it is
 * logged at error level and swallowed on purpose.
 */
export async function publishOrderEvent({ detailType, detail, correlationId }) {
  const busName = process.env.EVENT_BUS_NAME;
  if (!busName) return false;
  try {
    await getEvents().send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: 'ftw.retail',
            DetailType: detailType,
            Detail: JSON.stringify({ ...detail, correlationId }),
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    logEvent('error', 'putevents failed', {
      correlationId,
      busName,
      detailType,
      error: err.message,
    });
    return false;
  }
}

/** Tests and shutdown. Drops cached clients so the next call rebuilds them. */
export function resetClients() {
  sqsClient = null;
  eventsClient = null;
  signer = null;
}
