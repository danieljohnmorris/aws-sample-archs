// Retail HTTP surface. One handle() for both entrypoints, per CONTRACT.md.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { allowlistCheck, normaliseIp } from './allowlist.mjs';
import { correlationIdFrom, headerValue, logEvent, logRequest } from './log.mjs';
import {
  FULFILLED,
  PENDING,
  REJECTED,
  applyCheckResult,
  getOrder,
  insertOrder,
  needsPrescription,
  setStatus,
} from './orders.mjs';
import { fetchCheck, publishOrderEvent, sendCheckRequest, usesQueues } from './outbound.mjs';

const SERVICE = 'retail';

/**
 * request:  { method, path, query, headers, body, rawBody, sourceIp }
 * response: { status, headers, body }
 */
export async function handle(request) {
  const started = Date.now();
  const correlationId = correlationIdFrom(request.headers);
  let response;
  try {
    response = await route(request, correlationId);
  } catch (err) {
    logEvent('error', 'unhandled', {
      correlationId,
      path: request.path,
      error: err.message,
      stack: err.stack,
    });
    response = { status: 500, body: { error: 'internal_error' } };
  }
  const headers = {
    'content-type': 'application/json',
    'x-correlation-id': correlationId,
    ...(response.headers || {}),
  };
  logRequest({
    method: request.method,
    path: request.path,
    status: response.status,
    ms: Date.now() - started,
    correlationId,
    sourceIp: normaliseIp(request.sourceIp),
  });
  return { status: response.status, headers, body: response.body };
}

async function route(request, correlationId) {
  const { method, path } = request;

  if (method === 'GET' && path === '/health') {
    return { status: 200, body: { ok: true, service: SERVICE } };
  }

  const blocked = allowlistCheck(request, process.env.ALLOWED_CIDRS);
  if (blocked) return blocked;

  if (method === 'POST' && path === '/orders') return postOrder(request, correlationId);

  const order = path.match(/^\/orders\/([^/]+)$/);
  if (method === 'GET' && order) return getOrderRoute(decodeURIComponent(order[1]));

  if (method === 'POST' && path === '/internal/prescription-result') {
    return postPrescriptionResult(request, correlationId);
  }

  if (method === 'POST' && path === '/webhooks/payment') return postPaymentWebhook(request, correlationId);

  return { status: 404, body: { error: 'not_found', path } };
}

async function postOrder(request, correlationId) {
  const body = request.body || {};
  const { customerId, sku, prescriptionId } = body;
  const quantity = body.quantity;
  const missing = [];
  if (!customerId) missing.push('customerId');
  if (!sku) missing.push('sku');
  if (!Number.isInteger(quantity) || quantity < 1) missing.push('quantity');
  if (missing.length > 0) return { status: 400, body: { error: 'invalid_request', missing } };

  const orderId = randomUUID();
  await insertOrder({ orderId, customerId, sku, quantity, prescriptionId });

  if (!needsPrescription(sku)) {
    await setStatus(orderId, FULFILLED, null);
    await publishOrderEvent({
      detailType: 'OrderFulfilled',
      detail: { orderId, customerId, sku, quantity, status: FULFILLED },
      correlationId,
    });
    logEvent('info', 'order fulfilled', { correlationId, orderId, sku });
    return { status: 201, body: { orderId, status: FULFILLED } };
  }

  if (!prescriptionId) {
    await setStatus(orderId, REJECTED, 'prescriptionId is required for a prescription-only sku');
    logEvent('info', 'order rejected', { correlationId, orderId, reason: 'missing prescriptionId' });
    return {
      status: 201,
      body: {
        orderId,
        status: REJECTED,
        reason: 'prescriptionId is required for a prescription-only sku',
      },
    };
  }

  await publishOrderEvent({
    detailType: 'OrderCreated',
    detail: { orderId, customerId, sku, quantity, prescriptionId, status: PENDING },
    correlationId,
  });

  if (usesQueues()) {
    // Architecture B. The answer arrives on the result queue, so the caller polls.
    try {
      await sendCheckRequest({ orderId, prescriptionId, customerId, sku, correlationId });
    } catch (err) {
      logEvent('error', 'check request send failed', { correlationId, orderId, error: err.message });
      return { status: 502, body: { orderId, status: PENDING, error: 'check_request_failed' } };
    }
    return { status: 202, body: { orderId, status: PENDING } };
  }

  // Architectures A and C. Ask pharmacy now and answer with the decision.
  let check;
  try {
    check = await fetchCheck({ prescriptionId, customerId, sku, correlationId });
  } catch (err) {
    logEvent('error', 'prescription check failed', { correlationId, orderId, error: err.message });
    return { status: 502, body: { orderId, status: PENDING, error: 'prescription_check_failed' } };
  }

  const applied = await applyCheckResult({ orderId, valid: check.valid, reason: check.reason });
  const decided = applied.order;
  await publishOrderEvent({
    detailType: check.valid ? 'OrderFulfilled' : 'OrderRejected',
    detail: { orderId, customerId, sku, status: decided.status, reason: decided.reason },
    correlationId,
  });
  logEvent('info', 'order decided', {
    correlationId,
    orderId,
    status: decided.status,
    reason: decided.reason,
  });
  const responseBody = { orderId, status: decided.status };
  if (decided.reason) responseBody.reason = decided.reason;
  return { status: 201, body: responseBody };
}

async function getOrderRoute(orderId) {
  const row = await getOrder(orderId);
  if (!row) return { status: 404, body: { error: 'not_found', orderId } };
  const body = { orderId: row.order_id, status: row.status };
  if (row.reason) body.reason = row.reason;
  return { status: 200, body };
}

async function postPrescriptionResult(request, correlationId) {
  const body = request.body || {};
  if (!body.orderId || typeof body.valid !== 'boolean') {
    return { status: 400, body: { error: 'invalid_request', missing: ['orderId', 'valid'] } };
  }
  const applied = await applyCheckResult({
    orderId: body.orderId,
    valid: body.valid,
    reason: body.reason,
  });
  if (!applied.order) return { status: 404, body: { error: 'not_found', orderId: body.orderId } };
  logEvent('info', 'check result applied', {
    correlationId,
    orderId: body.orderId,
    applied: applied.applied,
    status: applied.order.status,
  });
  const responseBody = {
    orderId: applied.order.order_id,
    status: applied.order.status,
    applied: applied.applied,
  };
  if (applied.order.reason) responseBody.reason = applied.order.reason;
  return { status: 200, body: responseBody };
}

/**
 * Third-party inbound. The signature covers the bytes as they arrived, so the
 * raw body is what gets hashed, never a re-serialised object.
 */
function postPaymentWebhook(request, correlationId) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    logEvent('error', 'webhook secret missing', { correlationId });
    return { status: 500, body: { error: 'webhook_not_configured' } };
  }
  const provided = headerValue(request.headers, 'x-signature');
  if (!provided) return { status: 401, body: { error: 'missing_signature' } };

  const raw = typeof request.rawBody === 'string' ? request.rawBody : JSON.stringify(request.body ?? {});
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  if (!signatureMatches(provided, expected)) {
    logEvent('warn', 'webhook signature rejected', { correlationId });
    return { status: 401, body: { error: 'bad_signature' } };
  }
  logEvent('info', 'webhook accepted', { correlationId, event: request.body?.event ?? null });
  return { status: 200, body: { ok: true } };
}

/** Accepts a bare hex digest or a `sha256=` prefixed one. Compare is constant time. */
export function signatureMatches(provided, expectedHex) {
  const candidate = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  if (!/^[0-9a-fA-F]+$/.test(candidate)) return false;
  const left = Buffer.from(candidate.toLowerCase(), 'hex');
  const right = Buffer.from(expectedHex, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
