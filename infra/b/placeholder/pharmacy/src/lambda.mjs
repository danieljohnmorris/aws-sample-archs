// Placeholder pharmacy service. Stands in until apps/pharmacy lands on main so the
// stack has something to deploy. It answers health, echoes the route and logs
// one JSON line, which is enough to show the wiring works.
const log = (fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'pharmacy', level: 'info', ...fields }));

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = event.rawPath ?? event.path ?? '/';
  const correlationId = event.headers?.['x-correlation-id'] ?? `ph-${Date.now()}`;
  log({ msg: 'request', method, path, status: 200, correlationId, placeholder: true });
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      service: 'pharmacy',
      placeholder: true,
      method,
      path,
      checkRequestQueueUrl: process.env.CHECK_REQUEST_QUEUE_URL ?? null,
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    }),
  };
};

export const sqsHandler = async (event) => {
  for (const record of event.Records ?? []) {
    log({ msg: 'sqs record', messageId: record.messageId, body: record.body, placeholder: true });
  }
  return { batchItemFailures: [] };
};
