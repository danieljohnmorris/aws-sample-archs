// Proxy event mapping, driven through the exported handler. Pharmacy is the
// service with a query string on a route, so the query mapping is asserted here.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isV2, stripStage } from '../src/lambda.mjs';
import { SKIP, envSnapshot, useDatabase } from './helper.mjs';

const nextYear = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

const restEvent = (overrides = {}) => ({
  httpMethod: 'GET',
  path: '/prescriptions/RX-1/check',
  headers: { 'X-Correlation-Id': 'corr-1' },
  queryStringParameters: { customerId: 'c1', sku: 'RX-FOOD-1' },
  body: null,
  isBase64Encoded: false,
  requestContext: { stage: 'prod', identity: { sourceIp: '203.0.113.5' } },
  ...overrides,
});

const httpApiEvent = (overrides = {}) => ({
  version: '2.0',
  rawPath: '/prescriptions/RX-1/check',
  rawQueryString: 'customerId=c1&sku=RX-FOOD-1',
  headers: { 'x-correlation-id': 'corr-2' },
  body: null,
  isBase64Encoded: false,
  requestContext: {
    stage: '$default',
    http: { method: 'GET', path: '/prescriptions/RX-1/check', sourceIp: '198.51.100.9' },
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
  it('removes a named stage prefix', () => assert.equal(stripStage('/prod/check', 'prod'), '/check'));
  it('maps the bare stage path to root', () => assert.equal(stripStage('/prod', 'prod'), '/'));
  it('leaves $default alone', () => assert.equal(stripStage('/check', '$default'), '/check'));
  it('leaves a path that does not carry the stage', () =>
    assert.equal(stripStage('/check', 'prod'), '/check'));
  it('does not strip a partial name match', () =>
    assert.equal(stripStage('/production/check', 'prod'), '/production/check'));
});

describe('handler', { skip: SKIP }, () => {
  let handler;
  let closePool;
  let restoreEnv;

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL', 'ALLOWED_CIDRS']);
    await useDatabase('ftw_pharmacy_lambda_test');
    ({ closePool } = await import('../src/db.mjs'));
    const { seedPrescription } = await import('../src/prescriptions.mjs');
    await seedPrescription({
      prescriptionId: 'RX-1',
      customerId: 'c1',
      sku: 'RX-FOOD-1',
      expiresAt: nextYear(),
    });
    await seedPrescription({
      prescriptionId: 'RX-2',
      customerId: 'c1',
      sku: 'RX FOOD',
      expiresAt: nextYear(),
    });
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
    it('maps method, path and query onto a route', async () => {
      const result = await call(restEvent());
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json, { valid: true });
    });

    it('400s when the query is missing', async () => {
      const result = await call(restEvent({ queryStringParameters: null }));
      assert.equal(result.statusCode, 400);
      assert.equal(result.json.error, 'invalid_request');
    });

    it('takes the last value of a repeated multi-value query key', async () => {
      const result = await call(
        restEvent({
          queryStringParameters: null,
          multiValueQueryStringParameters: { customerId: ['c9', 'c1'], sku: ['RX-FOOD-1'] },
        }),
      );
      assert.deepEqual(result.json, { valid: true });
    });

    it('lets queryStringParameters win over the multi-value map', async () => {
      const result = await call(
        restEvent({
          queryStringParameters: { customerId: 'c1', sku: 'RX-FOOD-1' },
          multiValueQueryStringParameters: { customerId: ['c9'], sku: ['RX-OTHER-9'] },
        }),
      );
      assert.deepEqual(result.json, { valid: true });
    });

    it('decodes an escaped query value', async () => {
      const result = await call(
        restEvent({
          path: '/prescriptions/RX-2/check',
          queryStringParameters: { customerId: 'c1', sku: 'RX FOOD' },
        }),
      );
      assert.deepEqual(result.json, { valid: true });
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
      const result = await call(restEvent({ path: '/prod/health' }));
      assert.equal(result.statusCode, 404);
      assert.equal(result.json.path, '/prod/health');
    });

    it('decodes a base64 body before parsing', async () => {
      const raw = JSON.stringify({
        prescriptionId: 'RX-3',
        customerId: 'c1',
        sku: 'TEE-1',
        expiresAt: nextYear(),
      });
      const result = await call(
        restEvent({
          httpMethod: 'POST',
          path: '/prescriptions',
          queryStringParameters: null,
          body: Buffer.from(raw).toString('base64'),
          isBase64Encoded: true,
        }),
      );
      assert.equal(result.statusCode, 201);
      assert.deepEqual(result.json, { prescriptionId: 'RX-3' });
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
    it('maps method, path and query onto a route', async () => {
      const result = await call(httpApiEvent());
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json, { valid: true });
    });

    it('reads the query from queryStringParameters when rawQueryString is empty', async () => {
      const result = await call(
        httpApiEvent({ rawQueryString: '', queryStringParameters: { customerId: 'c1', sku: 'RX-FOOD-1' } }),
      );
      assert.deepEqual(result.json, { valid: true });
    });

    it('decodes an escaped query value', async () => {
      const result = await call(
        httpApiEvent({ rawPath: '/prescriptions/RX-2/check', rawQueryString: 'customerId=c1&sku=RX%20FOOD' }),
      );
      assert.deepEqual(result.json, { valid: true });
    });

    it('strips a named stage from rawPath', async () => {
      const event = httpApiEvent({ rawPath: '/live/prescriptions/RX-1/check' });
      event.requestContext.stage = 'live';
      const result = await call(event);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json, { valid: true });
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
  });

  describe('proxy response shape', () => {
    it('serialises status, headers and body', async () => {
      const event = httpApiEvent({ rawPath: '/health', rawQueryString: '' });
      const result = await handler(event);
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['content-type'], 'application/json');
      assert.equal(result.body, `{"ok":true,"service":"pharmacy"}`);
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
