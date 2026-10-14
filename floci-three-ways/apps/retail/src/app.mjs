// Retail HTTP surface. One Hono app serves both entrypoints, per CONTRACT.md:
// src/lambda.mjs hands it API Gateway events, src/server.mjs hands it a socket.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { allowlistCheck, normaliseIp } from './allowlist.mjs';
import { correlationIdFrom, logEvent, logRequest } from './log.mjs';
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

export const app = new Hono();

/**
 * Correlation id, the access log line, and the two headers every response
 * carries. Registered first so it wraps the allowlist and the 404 as well.
 */
app.use('*', async (c, next) => {
  const started = Date.now();
  const correlationId = correlationIdFrom(c.req.header());
  c.set('correlationId', correlationId);
  c.set('sourceIp', sourceIpOf(c));

  try {
    await next();
  } catch (err) {
    // app.onError takes anything thrown as an Error. This catches the rest, so
    // no request escapes without a response and a log line.
    c.res = failed(c, err);
  }

  c.res.headers.set('content-type', 'application/json');
  c.res.headers.set('x-correlation-id', correlationId);
  logRequest({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - started,
    correlationId,
    sourceIp: normaliseIp(c.get('sourceIp')),
  });
});

/** ALLOWED_CIDRS gate. /health is exempt, so health checks keep working. */
app.use('*', async (c, next) => {
  const blocked = allowlistCheck(
    { path: c.req.path, sourceIp: c.get('sourceIp') },
    process.env.ALLOWED_CIDRS,
  );
  if (blocked) return c.json(blocked.body, blocked.status);
  await next();
});

app.onError((err, c) => failed(c, err));

function failed(c, err) {
  logEvent('error', 'unhandled', {
    correlationId: c.get('correlationId'),
    path: c.req.path,
    error: err?.message,
    stack: err?.stack,
  });
  return c.json({ error: 'internal_error' }, 500);
}

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

app.get('/health', (c) => c.json({ ok: true, service: SERVICE }));

app.post('/orders', async (c) => {
  const correlationId = c.get('correlationId');
  const body = (await jsonBody(c)) || {};
  const { customerId, sku, prescriptionId } = body;
  const quantity = body.quantity;
  const missing = [];
  if (!customerId) missing.push('customerId');
  if (!sku) missing.push('sku');
  if (!Number.isInteger(quantity) || quantity < 1) missing.push('quantity');
  if (missing.length > 0) return c.json({ error: 'invalid_request', missing }, 400);

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
    return c.json({ orderId, status: FULFILLED }, 201);
  }

  if (!prescriptionId) {
    const reason = 'prescriptionId is required for a prescription-only sku';
    await setStatus(orderId, REJECTED, reason);
    logEvent('info', 'order rejected', { correlationId, orderId, reason: 'missing prescriptionId' });
    return c.json({ orderId, status: REJECTED, reason }, 201);
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
      return c.json({ orderId, status: PENDING, error: 'check_request_failed' }, 502);
    }
    return c.json({ orderId, status: PENDING }, 202);
  }

  // Architectures A and C. Ask pharmacy now and answer with the decision.
  let check;
  try {
    check = await fetchCheck({ prescriptionId, customerId, sku, correlationId });
  } catch (err) {
    logEvent('error', 'prescription check failed', { correlationId, orderId, error: err.message });
    return c.json({ orderId, status: PENDING, error: 'prescription_check_failed' }, 502);
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
  return c.json(responseBody, 201);
});

app.get('/orders/:id', async (c) => {
  const orderId = c.req.param('id');
  const row = await getOrder(orderId);
  if (!row) return c.json({ error: 'not_found', orderId }, 404);
  const body = { orderId: row.order_id, status: row.status };
  if (row.reason) body.reason = row.reason;
  return c.json(body);
});

app.post('/internal/prescription-result', async (c) => {
  const correlationId = c.get('correlationId');
  const body = (await jsonBody(c)) || {};
  if (!body.orderId || typeof body.valid !== 'boolean') {
    return c.json({ error: 'invalid_request', missing: ['orderId', 'valid'] }, 400);
  }
  const applied = await applyCheckResult({
    orderId: body.orderId,
    valid: body.valid,
    reason: body.reason,
  });
  if (!applied.order) return c.json({ error: 'not_found', orderId: body.orderId }, 404);
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
  return c.json(responseBody);
});

/**
 * Third-party inbound. The signature covers the bytes as they arrived, so the
 * raw text is what gets hashed, never a re-serialised object.
 */
app.post('/webhooks/payment', async (c) => {
  const correlationId = c.get('correlationId');
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    logEvent('error', 'webhook secret missing', { correlationId });
    return c.json({ error: 'webhook_not_configured' }, 500);
  }
  const provided = c.req.header('x-signature');
  if (!provided) return c.json({ error: 'missing_signature' }, 401);

  const raw = await c.req.text();
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  if (!signatureMatches(provided, expected)) {
    logEvent('warn', 'webhook signature rejected', { correlationId });
    return c.json({ error: 'bad_signature' }, 401);
  }
  logEvent('info', 'webhook accepted', { correlationId, event: parseJson(raw)?.event ?? null });
  return c.json({ ok: true });
});

/** Accepts a bare hex digest or a `sha256=` prefixed one. Compare is constant time. */
export function signatureMatches(provided, expectedHex) {
  const candidate = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  if (!/^[0-9a-fA-F]+$/.test(candidate)) return false;
  const left = Buffer.from(candidate.toLowerCase(), 'hex');
  const right = Buffer.from(expectedHex, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Lambda puts the caller's address on the event, the container puts it on the
 * socket. Behind an ALB or API Gateway the first x-forwarded-for hop is the
 * real caller, which is also the fallback when an event carries no address.
 */
function sourceIpOf(c) {
  const event = c.env?.event;
  if (event) {
    const context = event.requestContext;
    const fromEvent = context?.http?.sourceIp ?? context?.identity?.sourceIp;
    return fromEvent || firstForwardedHop(c) || '';
  }
  return firstForwardedHop(c) || c.env?.incoming?.socket?.remoteAddress || '';
}

function firstForwardedHop(c) {
  const forwarded = c.req.header('x-forwarded-for');
  if (!forwarded) return '';
  return forwarded.split(',')[0].trim();
}

/** The parsed JSON body, or null when there is none and when it will not parse. */
async function jsonBody(c) {
  return parseJson(await c.req.text());
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export default app;
