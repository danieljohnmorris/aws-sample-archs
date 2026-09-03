// Pharmacy HTTP surface. One Hono app serves both entrypoints, per CONTRACT.md:
// src/lambda.mjs hands it API Gateway events, src/server.mjs hands it a socket.
import { Hono } from 'hono';
import { allowlistCheck, normaliseIp } from './allowlist.mjs';
import { correlationIdFrom, logEvent, logRequest } from './log.mjs';
import { checkPrescription, seedPrescription } from './prescriptions.mjs';

const SERVICE = 'pharmacy';

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

  await next();

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

app.onError((err, c) => {
  logEvent('error', 'unhandled', {
    correlationId: c.get('correlationId'),
    path: c.req.path,
    error: err.message,
    stack: err.stack,
  });
  return c.json({ error: 'internal_error' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

app.get('/health', (c) => c.json({ ok: true, service: SERVICE }));

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
  const correlationId = c.get('correlationId');
  const prescriptionId = c.req.param('id');
  const customerId = c.req.query('customerId');
  const sku = c.req.query('sku');
  if (!customerId || !sku) {
    return c.json({ error: 'invalid_request', missing: ['customerId', 'sku'] }, 400);
  }
  const result = await checkPrescription({ prescriptionId, customerId, sku });
  logEvent('info', 'prescription checked', {
    correlationId,
    prescriptionId,
    valid: result.valid,
    reason: result.reason,
  });
  return c.json(result.valid ? { valid: true } : { valid: false, reason: result.reason });
});

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
