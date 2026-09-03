// Proxy event mapping only. No database, so this suite always runs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isV2, stripStage, toProxyResponse, toRequest } from '../src/lambda.mjs';

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

describe('toRequest, REST v1', () => {
  it('maps method, path, query and source IP', () => {
    const request = toRequest(restEvent());
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/orders/abc');
    assert.deepEqual(request.query, { customerId: 'c1' });
    assert.equal(request.sourceIp, '203.0.113.5');
  });

  it('lowercases header names', () => {
    assert.equal(toRequest(restEvent()).headers['x-correlation-id'], 'corr-1');
  });

  it('does not strip the stage from a REST path', () => {
    assert.equal(toRequest(restEvent({ path: '/prod/orders' })).path, '/prod/orders');
  });

  it('parses a JSON body and keeps the raw text', () => {
    const request = toRequest(restEvent({ httpMethod: 'POST', body: '{"customerId":"c1"}' }));
    assert.deepEqual(request.body, { customerId: 'c1' });
    assert.equal(request.rawBody, '{"customerId":"c1"}');
  });

  it('decodes a base64 body before parsing', () => {
    const raw = '{"customerId":"c9"}';
    const request = toRequest(
      restEvent({ httpMethod: 'POST', body: Buffer.from(raw).toString('base64'), isBase64Encoded: true }),
    );
    assert.equal(request.rawBody, raw);
    assert.deepEqual(request.body, { customerId: 'c9' });
  });

  it('gives a null body and empty raw text when there is none', () => {
    const request = toRequest(restEvent());
    assert.equal(request.body, null);
    assert.equal(request.rawBody, '');
  });

  it('gives a null body when the text is not JSON', () => {
    const request = toRequest(restEvent({ httpMethod: 'POST', body: 'not json' }));
    assert.equal(request.body, null);
    assert.equal(request.rawBody, 'not json');
  });

  it('folds multi-value headers and lets the single-value map win', () => {
    const request = toRequest(
      restEvent({ headers: { accept: 'application/json' }, multiValueHeaders: { Accept: ['text/plain'] } }),
    );
    assert.equal(request.headers.accept, 'application/json');
  });

  it('falls back to x-forwarded-for when the identity is missing', () => {
    const request = toRequest(
      restEvent({ requestContext: { stage: 'prod' }, headers: { 'X-Forwarded-For': '203.0.113.8, 10.0.0.1' } }),
    );
    assert.equal(request.sourceIp, '203.0.113.8');
  });
});

describe('toRequest, HTTP API v2', () => {
  it('maps method, path, query and source IP', () => {
    const request = toRequest(httpApiEvent());
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/orders/abc');
    assert.deepEqual(request.query, { customerId: 'c1', sku: 'RX-FOOD-1' });
    assert.equal(request.sourceIp, '198.51.100.9');
  });

  it('strips a named stage from rawPath', () => {
    const event = httpApiEvent({ rawPath: '/live/orders/abc' });
    event.requestContext.stage = 'live';
    assert.equal(toRequest(event).path, '/orders/abc');
  });

  it('reads the query from queryStringParameters when rawQueryString is empty', () => {
    const request = toRequest(httpApiEvent({ rawQueryString: '', queryStringParameters: { sku: 'TEE-1' } }));
    assert.deepEqual(request.query, { sku: 'TEE-1' });
  });

  it('decodes an encoded query value', () => {
    const request = toRequest(httpApiEvent({ rawQueryString: 'sku=RX%20FOOD' }));
    assert.equal(request.query.sku, 'RX FOOD');
  });
});

describe('toProxyResponse', () => {
  it('serialises status, headers and body', () => {
    const proxied = toProxyResponse({ status: 201, headers: { 'content-type': 'application/json' }, body: { orderId: 'x' } });
    assert.deepEqual(proxied, {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"orderId":"x"}',
      isBase64Encoded: false,
    });
  });

  it('sends an empty object when there is no body', () => {
    assert.equal(toProxyResponse({ status: 204 }).body, '{}');
  });
});
