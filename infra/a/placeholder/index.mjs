/**
 * Stand-in for apps/retail until the real service lands on main.
 *
 * Answers 200 to everything so the stack can be deployed and the perimeter
 * wiring checked before there is an application to run. RetailAppStack picks
 * this directory only when apps/retail/src/lambda.mjs is absent.
 */
export const handler = async (event) => {
  const path = event?.rawPath ?? event?.path ?? '/';
  const method = event?.httpMethod ?? event?.requestContext?.http?.method ?? 'GET';
  const correlationId =
    event?.headers?.['x-correlation-id'] ?? event?.headers?.['X-Correlation-Id'] ?? null;

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: process.env.SERVICE_NAME ?? 'retail',
      level: 'info',
      msg: 'placeholder handler',
      method,
      path,
      status: 200,
      ms: 0,
      correlationId,
      sourceIp: event?.requestContext?.identity?.sourceIp ?? null,
    }),
  );

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, placeholder: true, service: 'retail', path }),
  };
};
