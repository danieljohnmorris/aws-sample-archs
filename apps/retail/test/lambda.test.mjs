// Proxy event mapping, driven through the exported handler.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isV2, stripStage } from '../src/lambda.mjs';
import { SKIP, envSnapshot, useDatabase } from './helper.mjs';

const restEvent = (overrides = {}) => ({
  httpMethod: 'GET',
  path: '/orders/abc',
  headers: { 'X-Correlation-Id': 'corr-1' },
  queryStringParameters: { customerId: 'c1' },
  body: null,
  isBase64Encoded: false,
  requestContext: { stage: 'prod', identity: { sourceIp: '203.0.113.5' } },
  ...overrides,
});

const httpApiEvent = (overrides = {}) => ({
  version: '2.0',
  rawPath: '/orders/abc',
  rawQueryString: 'customerId=c1&sku=RX-FOOD-1',
  headers: { 'x-correlation-id': 'corr-2' },
  body: null,
  isBase64Encoded: false,
  requestContext: {
    stage: '$default',
    http: { method: 'POST', path: '/orders/abc', sourceIp: '198.51.100.9' },
  },
  ...overrides,
});

// No database, so these always run.
describe('isV2', () => {
  it('spots payload 2.0 by version', () => assert.equal(isV2({ version: '2.0' }), true));
  it('spots payload 2.0 by requestContext.http', () =>
    assert.equal(isV2({ requestContext: { http: {} } }), true));
  it('treats a REST event as v1', () => assert.equal(isV2(restEvent()), false));
});

describe('stripStage', () => {
  it('removes a named stage prefix', () => assert.equal(stripStage('/prod/orders', 'prod'), '/orders'));
  it('maps the bare stage path to root', () => assert.equal(stripStage('/prod', 'prod'), '/'));
  it('leaves $default alone', () => assert.equal(stripStage('/orders', '$default'), '/orders'));
  it('leaves a path that does not carry the stage', () =>
    assert.equal(stripStage('/orders', 'prod'), '/orders'));
  it('does not strip a partial name match', () =>
    assert.equal(stripStage('/production/orders', 'prod'), '/production/orders'));
});

describe('handler', { skip: SKIP }, () => {
  let handler;
  let closePool;
  let restoreEnv;

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL', 'ALLOWED_CIDRS', 'PAYMENT_WEBHOOK_SECRET', 'PHARMACY_BASE_URL']);
    await useDatabase('ftw_retail_lambda_test');
    ({ closePool } = await import('../src/db.mjs'));
    ({ handler } = await import('../src/lambda.mjs'));
  });

  after(async () => {
    await closePool();
    restoreEnv();
  });

  beforeEach(() => {
    delete process.env.ALLOWED_CIDRS;
  });

  /** Every response this service sends is JSON, so the body always parses. */
  const call = async (event) => {
    const result = await handler(event);
    return { ...result, json: JSON.parse(result.body) };
  };

  describe('REST v1', () => {
    it('maps method and path onto a route', async () => {
      const result = await call(restEvent());
      assert.equal(result.statusCode, 404);
      assert.deepEqual(result.json, { error: 'not_found', orderId: 'abc' });
    });

    it('reads the source IP from requestContext.identity', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const result = await call(restEvent());
      assert.equal(result.statusCode, 403);
      assert.deepEqual(result.json, { error: 'forbidden', sourceIp: '203.0.113.5' });
    });

    it('lowercases header names', async () => {
      const result = await call(restEvent());
      assert.equal(result.headers['x-correlation-id'], 'corr-1');
    });

    it('does not strip the stage from a REST path', async () => {
      const result = await call(restEvent({ path: '/prod/orders' }));
      assert.equal(result.statusCode, 404);
      assert.equal(result.json.path, '/prod/orders');
    });

    it('parses a JSON body', async () => {
      const result = await call(
        restEvent({ httpMethod: 'POST', path: '/orders', body: '{"customerId":"c1"}' }),
      );
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json.missing, ['sku', 'quantity']);
    });

    it('decodes a base64 body before parsing', async () => {
      const raw = '{"customerId":"c9","sku":"TEE-1","quantity":2}';
      const result = await call(
        restEvent({
          httpMethod: 'POST',
          path: '/orders',
          body: Buffer.from(raw).toString('base64'),
          isBase64Encoded: true,
        }),
      );
      assert.equal(result.statusCode, 201);
      assert.equal(result.json.status, 'FULFILLED');
    });

    it('treats no body as no fields', async () => {
      const result = await call(restEvent({ httpMethod: 'POST', path: '/orders' }));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json.missing, ['customerId', 'sku', 'quantity']);
    });

    it('treats a body that is not JSON as no fields', async () => {
      const result = await call(restEvent({ httpMethod: 'POST', path: '/orders', body: 'not json' }));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json.missing, ['customerId', 'sku', 'quantity']);
    });

    it('hashes the webhook body exactly as it arrived', async () => {
      process.env.PAYMENT_WEBHOOK_SECRET = 'lambda-secret';
      const { createHmac } = await import('node:crypto');
      const raw = '{ "event" : "payment.succeeded" }';
      const result = await call(
        restEvent({
          httpMethod: 'POST',
          path: '/webhooks/payment',
          body: raw,
          headers: {
            'X-Signature': createHmac('sha256', 'lambda-secret').update(raw, 'utf8').digest('hex'),
          },
        }),
      );
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json, { ok: true });
    });

    it('folds multi-value headers and lets the single-value map win', async () => {
      const result = await call(
        restEvent({
          headers: { 'x-correlation-id': 'from-headers' },
          multiValueHeaders: { 'X-Correlation-Id': ['from-multi'] },
        }),
      );
      assert.equal(result.headers['x-correlation-id'], 'from-headers');
    });

    it('reads a header that only the multi-value map carries', async () => {
      const result = await call(
        restEvent({ headers: {}, multiValueHeaders: { 'X-Correlation-Id': ['from-multi'] } }),
      );
      assert.equal(result.headers['x-correlation-id'], 'from-multi');
    });

    it('falls back to x-forwarded-for when the identity is missing', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const result = await call(
        restEvent({
          requestContext: { stage: 'prod' },
          headers: { 'X-Forwarded-For': '203.0.113.8, 10.0.0.1' },
        }),
      );
      assert.equal(result.statusCode, 403);
      assert.equal(result.json.sourceIp, '203.0.113.8');
    });
  });

  describe('HTTP API v2', () => {
    it('maps method and path onto a route', async () => {
      const result = await call(httpApiEvent());
      assert.equal(result.statusCode, 404);
      assert.deepEqual(result.json, { error: 'not_found', path: '/orders/abc' });
    });

    it('reads the source IP from requestContext.http', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const result = await call(httpApiEvent());
      assert.equal(result.statusCode, 403);
      assert.deepEqual(result.json, { error: 'forbidden', sourceIp: '198.51.100.9' });
    });

    it('echoes the correlation id off a lowercase header', async () => {
      const result = await call(httpApiEvent());
      assert.equal(result.headers['x-correlation-id'], 'corr-2');
    });

    it('strips a named stage from rawPath', async () => {
      const event = httpApiEvent({ rawPath: '/live/health' });
      event.requestContext.stage = 'live';
      event.requestContext.http.method = 'GET';
      const result = await call(event);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json, { ok: true, service: 'retail' });
    });

    it('takes the method from requestContext.http', async () => {
      const event = httpApiEvent({ rawPath: '/orders', body: '{"customerId":"c1"}' });
      const result = await call(event);
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json.missing, ['sku', 'quantity']);
    });
  });

  describe('proxy response shape', () => {
    it('serialises status, headers and body', async () => {
      const event = httpApiEvent({ rawPath: '/health' });
      event.requestContext.http.method = 'GET';
      const result = await handler(event);
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['content-type'], 'application/json');
      assert.equal(result.body, `{"ok":true,"service":"retail"}`);
      assert.equal(result.isBase64Encoded, false);
    });

    it('sends plain headers even when the event carries multi-value ones', async () => {
      const result = await handler(restEvent({ multiValueHeaders: { Accept: ['application/json'] } }));
      assert.equal(result.multiValueHeaders, undefined);
      assert.equal(result.headers['content-type'], 'application/json');
      assert.equal(result.isBase64Encoded, false);
    });
  });
});
