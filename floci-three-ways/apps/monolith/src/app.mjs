// Simplified monolith. Retail and pharmacy in one Hono app. The prescription
// check is a function call inside POST /orders, so there is no pharmacy URL,
// no queue and no second service to secure. One /health for the one process.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { correlationIdFrom, logEvent, logRequest } from './log.mjs';
import { FULFILLED, REJECTED, getOrder, insertOrder, needsPrescription } from './orders.mjs';
import { checkPrescription, seedPrescription } from './pharmacy.mjs';

const SERVICE = 'monolith';

export const app = new Hono();

app.use('*', async (c, next) => {
  const started = Date.now();
  const correlationId = correlationIdFrom(c.req.header());
  c.set('correlationId', correlationId);
  try {
    await next();
  } catch (err) {
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
    sourceIp: sourceIpOf(c),
  });
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

// Retail routes.

app.post('/orders', async (c) => {
  const correlationId = c.get('correlationId');
  const body = (await jsonBody(c)) || {};
  const { customerId, sku, prescriptionId, quantity } = body;
  const missing = [];
  if (!customerId) missing.push('customerId');
  if (!sku) missing.push('sku');
  if (!Number.isInteger(quantity) || quantity < 1) missing.push('quantity');
  if (missing.length > 0) return c.json({ error: 'invalid_request', missing }, 400);

  const orderId = randomUUID();
  let status = FULFILLED;
  let reason = null;

  if (needsPrescription(sku)) {
    if (!prescriptionId) {
      status = REJECTED;
      reason = 'prescriptionId is required for a prescription-only sku';
    } else {
      // The whole of the cross-service call in this architecture.
      const check = await checkPrescription({ prescriptionId, customerId, sku });
      if (!check.valid) {
        status = REJECTED;
        reason = check.reason;
      }
    }
  }

  await insertOrder({ orderId, customerId, sku, quantity, prescriptionId, status, reason });
  logEvent('info', 'order decided', { correlationId, orderId, sku, status, reason });
  const responseBody = { orderId, status };
  if (reason) responseBody.reason = reason;
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
  logEvent('info', 'webhook accepted', { correlationId });
  return c.json({ ok: true });
});

// Pharmacy routes. Same paths as apps/pharmacy so the e2e scenario is unchanged.

app.post('/prescriptions', async (c) => {
  const correlationId = c.get('correlationId');
  const body = (await jsonBody(c)) || {};
  const missing = ['prescriptionId', 'customerId', 'sku', 'expiresAt'].filter((field) => !body[field]);
  if (missing.length > 0) return c.json({ error: 'invalid_request', missing }, 400);
  if (Number.isNaN(new Date(body.expiresAt).getTime())) {
    return c.json({ error: 'invalid_request', field: 'expiresAt' }, 400);
  }
  await seedPrescription(body);
  logEvent('info', 'prescription seeded', { correlationId, prescriptionId: body.prescriptionId });
  return c.json({ prescriptionId: body.prescriptionId }, 201);
});

app.get('/prescriptions/:id/check', async (c) => {
  const customerId = c.req.query('customerId');
  const sku = c.req.query('sku');
  if (!customerId || !sku) {
    return c.json({ error: 'invalid_request', missing: ['customerId', 'sku'] }, 400);
  }
  const result = await checkPrescription({ prescriptionId: c.req.param('id'), customerId, sku });
  return c.json(result.valid ? { valid: true } : { valid: false, reason: result.reason });
});

export function signatureMatches(provided, expectedHex) {
  const candidate = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  if (!/^[0-9a-fA-F]+$/.test(candidate)) return false;
  const left = Buffer.from(candidate.toLowerCase(), 'hex');
  const right = Buffer.from(expectedHex, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sourceIpOf(c) {
  const event = c.env?.event;
  const context = event?.requestContext;
  const fromEvent = context?.http?.sourceIp ?? context?.identity?.sourceIp;
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
  return fromEvent || forwarded || c.env?.incoming?.socket?.remoteAddress || '';
}

async function jsonBody(c) {
  const raw = await c.req.text();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export default app;
