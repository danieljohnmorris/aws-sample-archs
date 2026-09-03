// Pharmacy HTTP surface. One handle() for both entrypoints, per CONTRACT.md.
import { allowlistCheck, normaliseIp } from './allowlist.mjs';
import { correlationIdFrom, logEvent, logRequest } from './log.mjs';
import { checkPrescription, seedPrescription } from './prescriptions.mjs';

const SERVICE = 'pharmacy';

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

  if (method === 'POST' && path === '/prescriptions') {
    return postPrescription(request, correlationId);
  }

  const check = path.match(/^\/prescriptions\/([^/]+)\/check$/);
  if (method === 'GET' && check) {
    return getCheck(decodeURIComponent(check[1]), request, correlationId);
  }

  return { status: 404, body: { error: 'not_found', path } };
}

async function postPrescription(request, correlationId) {
  const body = request.body || {};
  const missing = ['prescriptionId', 'customerId', 'sku', 'expiresAt'].filter((field) => !body[field]);
  if (missing.length > 0) {
    return { status: 400, body: { error: 'invalid_request', missing } };
  }
  if (Number.isNaN(new Date(body.expiresAt).getTime())) {
    return { status: 400, body: { error: 'invalid_request', field: 'expiresAt' } };
  }
  await seedPrescription(body);
  logEvent('info', 'prescription seeded', { correlationId, prescriptionId: body.prescriptionId });
  return { status: 201, body: { prescriptionId: body.prescriptionId } };
}

async function getCheck(prescriptionId, request, correlationId) {
  const customerId = request.query?.customerId;
  const sku = request.query?.sku;
  if (!customerId || !sku) {
    return { status: 400, body: { error: 'invalid_request', missing: ['customerId', 'sku'] } };
  }
  const result = await checkPrescription({ prescriptionId, customerId, sku });
  logEvent('info', 'prescription checked', {
    correlationId,
    prescriptionId,
    valid: result.valid,
    reason: result.reason,
  });
  const body = result.valid ? { valid: true } : { valid: false, reason: result.reason };
  return { status: 200, body };
}
