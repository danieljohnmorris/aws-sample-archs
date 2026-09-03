// API Gateway proxy entrypoint. Handles REST v1 events and HTTP API v2
// payload 2.0 events, and re-exports the SQS consumer for architecture B.
import { handle } from './app.mjs';

export { sqsHandler } from './consumer.mjs';

/** Payload 2.0 announces itself; REST v1 does not. */
export function isV2(event) {
  return event?.version === '2.0' || Boolean(event?.requestContext?.http);
}

/** HTTP API rawPath carries the stage when the stage is not $default. */
export function stripStage(path, stage) {
  if (!stage || stage === '$default') return path || '/';
  const prefix = `/${stage}`;
  if (path === prefix) return '/';
  if (path?.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return path || '/';
}

/** Flattens a proxy event into the request shape from CONTRACT.md. */
export function toRequest(event) {
  const v2 = isV2(event);
  const headers = lowercaseHeaders(event?.headers, event?.multiValueHeaders);
  const rawBody = decodeBody(event);
  const method = v2 ? event.requestContext.http.method : event.httpMethod;
  const path = v2
    ? stripStage(event.rawPath || event.requestContext.http.path, event.requestContext?.stage)
    : event.path || '/';
  const sourceIp = v2
    ? event.requestContext?.http?.sourceIp
    : event.requestContext?.identity?.sourceIp;

  return {
    method: (method || 'GET').toUpperCase(),
    path: path || '/',
    query: buildQuery(event, v2),
    headers,
    body: parseJson(rawBody),
    rawBody,
    sourceIp: sourceIp || headers['x-forwarded-for']?.split(',')[0]?.trim() || '',
  };
}

/** Back to the proxy response shape. Identical for v1 and v2. */
export function toProxyResponse(response) {
  return {
    statusCode: response.status,
    headers: response.headers || { 'content-type': 'application/json' },
    body: JSON.stringify(response.body ?? {}),
    isBase64Encoded: false,
  };
}

export async function handler(event) {
  return toProxyResponse(await handle(toRequest(event)));
}

function lowercaseHeaders(headers, multiValueHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(multiValueHeaders || {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  for (const [key, value] of Object.entries(headers || {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

function buildQuery(event, v2) {
  const query = {};
  if (v2 && typeof event.rawQueryString === 'string' && event.rawQueryString.length > 0) {
    for (const [key, value] of new URLSearchParams(event.rawQueryString)) query[key] = value;
    return query;
  }
  for (const [key, value] of Object.entries(event?.multiValueQueryStringParameters || {})) {
    query[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  for (const [key, value] of Object.entries(event?.queryStringParameters || {})) {
    query[key] = value;
  }
  return query;
}

function decodeBody(event) {
  if (event?.body === undefined || event?.body === null) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
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
