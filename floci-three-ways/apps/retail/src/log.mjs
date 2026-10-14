// One JSON line per request on stdout. Fields are fixed by CONTRACT.md.
import { randomUUID } from 'node:crypto';

const SERVICE = process.env.SERVICE_NAME || 'retail';

/** Pull `x-correlation-id` off inbound headers, or make one. */
export function correlationIdFrom(headers) {
  const found = headerValue(headers, 'x-correlation-id');
  return found && found.trim() ? found.trim() : randomUUID();
}

/** Case-insensitive header lookup. API Gateway and node:http disagree on case. */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      return Array.isArray(value) ? value.join(',') : value;
    }
  }
  return undefined;
}

/** The access line. Called once per request, after the response is decided. */
export function logRequest({ method, path, status, ms, correlationId, sourceIp, msg }) {
  write({
    level: 'info',
    msg: msg || 'request',
    method,
    path,
    status,
    ms,
    correlationId,
    sourceIp,
  });
}

/** Anything that is not a request: consumer work, startup, failures. */
export function logEvent(level, msg, fields = {}) {
  write({ level, msg, ...fields });
}

function write(fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE, ...fields }) + '\n');
}
