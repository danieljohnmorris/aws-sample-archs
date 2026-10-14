// API Gateway proxy entrypoint. Handles REST v1 events and HTTP API v2
// payload 2.0 events, and re-exports the SQS consumer for architecture B.
import { handle } from 'hono/aws-lambda';
import { app } from './app.mjs';

export { sqsHandler } from './consumer.mjs';

const honoHandler = handle(app);

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

export async function handler(event, context) {
  return toProxyResponse(await honoHandler(normalise(event), context));
}

/**
 * API Gateway describes one request in several overlapping fields, and the
 * adapter reads only some of them: rawPath and rawQueryString on a v2 event,
 * both header maps at once on a v1 event. So the event is put in one shape
 * first, matching what this service read before Hono:
 *
 * - the stage comes off a v2 path
 * - the two header maps become one, the single-value map winning
 * - the two query maps become one query string, the last value of a repeated
 *   key winning
 */
function normalise(event) {
  const query = new URLSearchParams(buildQuery(event)).toString();
  if (isV2(event)) {
    const rawPath = event.rawPath || event.requestContext?.http?.path || '/';
    return {
      ...event,
      rawPath: stripStage(rawPath, event.requestContext?.stage),
      rawQueryString: query,
    };
  }
  const { multiValueHeaders, multiValueQueryStringParameters, ...rest } = event || {};
  return {
    ...rest,
    headers: buildHeaders(event),
    queryStringParameters: Object.fromEntries(new URLSearchParams(query)),
  };
}

function buildHeaders(event) {
  const out = {};
  for (const [key, value] of Object.entries(event?.multiValueHeaders || {})) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  for (const [key, value] of Object.entries(event?.headers || {})) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

function buildQuery(event) {
  const query = {};
  if (isV2(event) && typeof event.rawQueryString === 'string' && event.rawQueryString.length > 0) {
    for (const [key, value] of new URLSearchParams(event.rawQueryString)) query[key] = value;
    return query;
  }
  for (const [key, value] of Object.entries(event?.multiValueQueryStringParameters || {})) {
    if (value === undefined || value === null) continue;
    query[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  for (const [key, value] of Object.entries(event?.queryStringParameters || {})) {
    if (value === undefined || value === null) continue;
    query[key] = value;
  }
  return query;
}

/**
 * One proxy response shape for both payload versions, as before: a plain
 * headers map and never base64. The adapter answers an event carrying
 * multiValueHeaders in kind, so that form is folded back.
 */
function toProxyResponse(result) {
  const headers = { ...(result.headers || {}) };
  for (const [key, value] of Object.entries(result.multiValueHeaders || {})) {
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return {
    statusCode: result.statusCode,
    headers,
    body: result.body ?? '{}',
    isBase64Encoded: result.isBase64Encoded ?? false,
  };
}
