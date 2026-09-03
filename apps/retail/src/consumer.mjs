// Architecture B, retail side. Reads PrescriptionCheckCompleted off
// CHECK_RESULT_QUEUE_URL and moves the order out of PENDING.
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { claimMessage, query } from './db.mjs';
import { logEvent } from './log.mjs';
import { applyCheckResult } from './orders.mjs';

let client = null;
let running = false;

function getClient() {
  if (!client) {
    // Region left unset when the environment does not say, so the SDK resolves
    // it the way it normally would. No region is named here.
    const config = {};
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (region) config.region = region;
    if (process.env.AWS_ENDPOINT_URL) config.endpoint = process.env.AWS_ENDPOINT_URL;
    client = new SQSClient(config);
  }
  return client;
}

/**
 * Processes one message body. Duplicates are dropped on idempotencyKey.
 * The claim is released when the work throws, so a redelivery can retry.
 */
export async function handleResultMessage(rawBody, correlationId = null) {
  const message = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  if (message.type !== 'PrescriptionCheckCompleted') {
    logEvent('warn', 'unexpected message type', { correlationId, type: message.type });
    return { skipped: 'type' };
  }
  const key = message.idempotencyKey || message.orderId;
  if (!key) throw new Error('message has no idempotencyKey');

  const claimed = await claimMessage(key);
  if (!claimed) {
    logEvent('info', 'duplicate dropped', { correlationId, idempotencyKey: key });
    return { skipped: 'duplicate' };
  }

  try {
    const applied = await applyCheckResult({
      orderId: message.orderId,
      valid: Boolean(message.valid),
      reason: message.reason ?? null,
    });
    logEvent('info', 'check result applied', {
      correlationId,
      orderId: message.orderId,
      applied: applied.applied,
      status: applied.order?.status ?? null,
    });
    return { applied: applied.applied, status: applied.order?.status ?? null };
  } catch (err) {
    await query('DELETE FROM processed_messages WHERE idempotency_key = $1', [key]);
    throw err;
  }
}

/** Lambda event source mapping entrypoint. Throws so SQS retries the batch. */
export async function sqsHandler(event) {
  for (const record of event?.Records || []) {
    const correlationId =
      record.messageAttributes?.correlationId?.stringValue ||
      record.messageAttributes?.correlationId?.StringValue ||
      null;
    await handleResultMessage(record.body, correlationId);
  }
  return { batchItemFailures: [] };
}

/**
 * Container mode. Long-polls the result queue until stopConsumer() is called.
 * Returns immediately when CHECK_RESULT_QUEUE_URL is unset.
 */
export function startConsumer() {
  const queueUrl = process.env.CHECK_RESULT_QUEUE_URL;
  if (!queueUrl) return null;
  running = true;
  logEvent('info', 'consumer started', { queueUrl });
  const loop = (async () => {
    while (running) {
      try {
        const received = await getClient().send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            MessageAttributeNames: ['All'],
          }),
        );
        for (const message of received.Messages || []) {
          const correlationId =
            message.MessageAttributes?.correlationId?.StringValue || null;
          try {
            await handleResultMessage(message.Body, correlationId);
            await getClient().send(
              new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
            );
          } catch (err) {
            // Left on the queue on purpose. Redelivery retries, the DLQ catches poison.
            logEvent('error', 'result message failed', {
              correlationId,
              messageId: message.MessageId,
              error: err.message,
            });
          }
        }
      } catch (err) {
        if (!running) break;
        logEvent('error', 'receive failed', { queueUrl, error: err.message });
        await sleep(2000);
      }
    }
    logEvent('info', 'consumer stopped', { queueUrl });
  })();
  return loop;
}

export function stopConsumer() {
  running = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
