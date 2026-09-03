import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP, envSnapshot, stubPharmacy, stubSqs, testRegion, truncate, useDatabase } from './helper.mjs';

const SECRET = 'shh-test-secret';

describe('retail handle()', { skip: SKIP }, () => {
  let handle;
  let query;
  let closePool;
  let resetClients;
  let pharmacy;
  let sqs;
  let restoreEnv;

  before(async () => {
    restoreEnv = envSnapshot([
      'DATABASE_URL',
      'ALLOWED_CIDRS',
      'PAYMENT_WEBHOOK_SECRET',
      'PHARMACY_BASE_URL',
      'SIGN_REQUESTS',
      'CHECK_REQUEST_QUEUE_URL',
      'EVENT_BUS_NAME',
      'AWS_ENDPOINT_URL',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]);
    await useDatabase('ftw_retail_app_test');
    pharmacy = await stubPharmacy({
      'RX-OK': { valid: true },
      'RX-WRONG-CUSTOMER': { valid: false, reason: 'prescription belongs to a different customer' },
      'RX-EXPIRED': { valid: false, reason: 'prescription expired' },
      'RX-BROKEN': { status: 500, body: { error: 'boom' } },
    });
    sqs = await stubSqs();
    process.env.AWS_REGION = testRegion();
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_ENDPOINT_URL = sqs.endpoint;
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ resetClients } = await import('../src/outbound.mjs'));
    ({ handle } = await import('../src/app.mjs'));
  });

  after(async () => {
    await closePool();
    await pharmacy.close();
    await sqs.close();
    restoreEnv();
  });

  beforeEach(async () => {
    delete process.env.ALLOWED_CIDRS;
    delete process.env.CHECK_REQUEST_QUEUE_URL;
    delete process.env.SIGN_REQUESTS;
    delete process.env.EVENT_BUS_NAME;
    process.env.PHARMACY_BASE_URL = pharmacy.baseUrl;
    process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
    pharmacy.calls.length = 0;
    sqs.sent.length = 0;
    resetClients();
    await truncate(query, ['orders', 'processed_messages']);
  });

  const request = (overrides) => ({
    method: 'GET',
    path: '/health',
    query: {},
    headers: {},
    body: null,
    rawBody: '',
    sourceIp: '10.0.0.1',
    ...overrides,
  });

  const postOrder = (body, overrides = {}) =>
    handle(request({ method: 'POST', path: '/orders', body, ...overrides }));

  it('answers /health', async () => {
    const response = await handle(request({ path: '/health' }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, service: 'retail' });
  });

  it('404s an unknown route', async () => {
    const response = await handle(request({ path: '/nope' }));
    assert.equal(response.status, 404);
  });

  describe('POST /orders', () => {
    it('fulfils a non-prescription sku at once and never calls pharmacy', async () => {
      const response = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity: 2 });
      assert.equal(response.status, 201);
      assert.equal(response.body.status, 'FULFILLED');
      assert.match(response.body.orderId, /^[0-9a-f-]{36}$/);
      assert.equal(pharmacy.calls.length, 0);
    });

    it('rejects a body with fields missing', async () => {
      const response = await postOrder({ sku: 'TEE-1' });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.missing, ['customerId', 'quantity']);
    });

    it('rejects a quantity that is not a positive integer', async () => {
      for (const quantity of [0, -1, 1.5, '2', null]) {
        const response = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity });
        assert.equal(response.status, 400, String(quantity));
        assert.ok(response.body.missing.includes('quantity'));
      }
    });

    it('rejects an RX sku with no prescriptionId', async () => {
      const response = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1 });
      assert.equal(response.body.status, 'REJECTED');
      assert.match(response.body.reason, /prescriptionId/);
      assert.equal(pharmacy.calls.length, 0);
    });

    describe('architecture A, synchronous HTTP', () => {
      it('fulfils when pharmacy says the prescription is valid', async () => {
        const response = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' });
        assert.equal(response.status, 201);
        assert.equal(response.body.status, 'FULFILLED');
        assert.equal(pharmacy.calls.length, 1);
        assert.deepEqual(pharmacy.calls[0].query, { customerId: 'c1', sku: 'RX-FOOD-1' });
        assert.equal(pharmacy.calls[0].path, '/prescriptions/RX-OK/check');
      });

      it('rejects with the reason pharmacy gave', async () => {
        const response = await postOrder({
          customerId: 'c2',
          sku: 'RX-FOOD-1',
          quantity: 1,
          prescriptionId: 'RX-WRONG-CUSTOMER',
        });
        assert.equal(response.body.status, 'REJECTED');
        assert.match(response.body.reason, /customer/);
      });

      it('rejects an expired prescription', async () => {
        const response = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-EXPIRED' });
        assert.equal(response.body.status, 'REJECTED');
        assert.match(response.body.reason, /expired/);
      });

      it('forwards the correlation id to pharmacy', async () => {
        await postOrder(
          { customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' },
          { headers: { 'x-correlation-id': 'corr-out' } },
        );
        assert.equal(pharmacy.calls[0].headers['x-correlation-id'], 'corr-out');
      });

      it('leaves the order PENDING and 502s when pharmacy errors', async () => {
        const response = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-BROKEN' });
        assert.equal(response.status, 502);
        assert.equal(response.body.status, 'PENDING');
        assert.equal(response.body.error, 'prescription_check_failed');
        const stored = await handle(request({ path: `/orders/${response.body.orderId}` }));
        assert.equal(stored.body.status, 'PENDING');
      });
    });

    describe('architecture C, signed requests', () => {
      it('signs the outbound call when SIGN_REQUESTS is true', async () => {
        process.env.SIGN_REQUESTS = 'true';
        const response = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' });
        assert.equal(response.body.status, 'FULFILLED');
        const authorization = pharmacy.calls[0].headers.authorization;
        assert.match(authorization, /^AWS4-HMAC-SHA256 /);
        assert.match(authorization, /\/execute-api\/aws4_request/);
        assert.ok(pharmacy.calls[0].headers['x-amz-date']);
      });

      it('leaves the call unsigned otherwise', async () => {
        await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' });
        assert.equal(pharmacy.calls[0].headers.authorization, undefined);
      });
    });

    describe('architecture B, queues', () => {
      beforeEach(() => {
        process.env.CHECK_REQUEST_QUEUE_URL = `${sqs.endpoint}/000000000000/check-request`;
        resetClients();
      });

      it('returns PENDING and puts a request on the queue', async () => {
        const response = await postOrder(
          { customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' },
          { headers: { 'x-correlation-id': 'corr-b' } },
        );
        assert.equal(response.status, 202);
        assert.equal(response.body.status, 'PENDING');
        assert.equal(pharmacy.calls.length, 0);
        assert.equal(sqs.sent.length, 1);
        const message = JSON.parse(sqs.sent[0].MessageBody);
        assert.deepEqual(message, {
          type: 'PrescriptionCheckRequested',
          orderId: response.body.orderId,
          prescriptionId: 'RX-OK',
          customerId: 'c1',
          sku: 'RX-FOOD-1',
          idempotencyKey: response.body.orderId,
        });
        assert.equal(sqs.sent[0].MessageAttributes.correlationId.StringValue, 'corr-b');
      });

      it('still fulfils a non-prescription sku without a message', async () => {
        const response = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity: 1 });
        assert.equal(response.body.status, 'FULFILLED');
        assert.equal(sqs.sent.length, 0);
      });
    });
  });

  describe('GET /orders/:id', () => {
    it('returns the stored status', async () => {
      const created = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity: 1 });
      const response = await handle(request({ path: `/orders/${created.body.orderId}` }));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { orderId: created.body.orderId, status: 'FULFILLED' });
    });

    it('includes the reason when there is one', async () => {
      const created = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-EXPIRED' });
      const response = await handle(request({ path: `/orders/${created.body.orderId}` }));
      assert.match(response.body.reason, /expired/);
    });

    it('404s an unknown order', async () => {
      const response = await handle(request({ path: '/orders/does-not-exist' }));
      assert.equal(response.status, 404);
    });
  });

  describe('POST /internal/prescription-result', () => {
    const pending = async () => {
      process.env.CHECK_REQUEST_QUEUE_URL = `${sqs.endpoint}/000000000000/check-request`;
      resetClients();
      const created = await postOrder({ customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-OK' });
      delete process.env.CHECK_REQUEST_QUEUE_URL;
      return created.body.orderId;
    };

    it('fulfils a pending order', async () => {
      const orderId = await pending();
      const response = await handle(
        request({ method: 'POST', path: '/internal/prescription-result', body: { orderId, valid: true } }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'FULFILLED');
      assert.equal(response.body.applied, true);
    });

    it('rejects a pending order with a reason', async () => {
      const orderId = await pending();
      const response = await handle(
        request({
          method: 'POST',
          path: '/internal/prescription-result',
          body: { orderId, valid: false, reason: 'prescription expired' },
        }),
      );
      assert.equal(response.body.status, 'REJECTED');
      assert.equal(response.body.reason, 'prescription expired');
    });

    it('does not rewrite a decision on a second call', async () => {
      const orderId = await pending();
      const body = { orderId, valid: true };
      const first = await handle(request({ method: 'POST', path: '/internal/prescription-result', body }));
      assert.equal(first.body.applied, true);
      const second = await handle(
        request({
          method: 'POST',
          path: '/internal/prescription-result',
          body: { orderId, valid: false, reason: 'late reversal' },
        }),
      );
      assert.equal(second.body.applied, false);
      assert.equal(second.body.status, 'FULFILLED');
    });

    it('400s a body with no orderId or valid flag', async () => {
      const response = await handle(
        request({ method: 'POST', path: '/internal/prescription-result', body: { orderId: 'x' } }),
      );
      assert.equal(response.status, 400);
    });

    it('404s an unknown order', async () => {
      const response = await handle(
        request({ method: 'POST', path: '/internal/prescription-result', body: { orderId: 'nope', valid: true } }),
      );
      assert.equal(response.status, 404);
    });
  });

  describe('POST /webhooks/payment', () => {
    const raw = JSON.stringify({ event: 'payment.succeeded', amount: 4200 });
    const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

    const post = (headers, rawBody = raw) =>
      handle(
        request({
          method: 'POST',
          path: '/webhooks/payment',
          headers,
          rawBody,
          body: JSON.parse(rawBody),
        }),
      );

    it('accepts a correct signature', async () => {
      const response = await post({ 'x-signature': sign(raw) });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
    });

    it('accepts the sha256= prefixed form', async () => {
      const response = await post({ 'x-signature': `sha256=${sign(raw)}` });
      assert.equal(response.status, 200);
    });

    it('is case insensitive about the header name', async () => {
      const response = await post({ 'X-Signature': sign(raw) });
      assert.equal(response.status, 200);
    });

    it('401s a signature made with the wrong secret', async () => {
      const response = await post({ 'x-signature': sign(raw, 'wrong-secret') });
      assert.equal(response.status, 401);
      assert.equal(response.body.error, 'bad_signature');
    });

    it('401s when the body was altered after signing', async () => {
      const signature = sign(raw);
      const altered = JSON.stringify({ event: 'payment.succeeded', amount: 999999 });
      const response = await post({ 'x-signature': signature }, altered);
      assert.equal(response.status, 401);
    });

    it('401s a missing signature', async () => {
      const response = await post({});
      assert.equal(response.status, 401);
      assert.equal(response.body.error, 'missing_signature');
    });

    it('401s a signature that is not hex', async () => {
      const response = await post({ 'x-signature': 'not-a-signature' });
      assert.equal(response.status, 401);
      assert.equal(response.body.error, 'bad_signature');
    });

    it('401s a signature of the wrong length', async () => {
      const response = await post({ 'x-signature': 'abcd' });
      assert.equal(response.status, 401);
    });

    it('500s when the secret is not configured', async () => {
      delete process.env.PAYMENT_WEBHOOK_SECRET;
      const response = await post({ 'x-signature': sign(raw) });
      assert.equal(response.status, 500);
      assert.equal(response.body.error, 'webhook_not_configured');
    });
  });

  describe('allowlist', () => {
    it('lets an address inside the range through', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity: 1 }, { sourceIp: '10.9.9.9' });
      assert.equal(response.status, 201);
    });

    it('403s an address outside every range', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await postOrder({ customerId: 'c1', sku: 'TEE-1', quantity: 1 }, { sourceIp: '203.0.113.9' });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'forbidden', sourceIp: '203.0.113.9' });
    });

    it('exempts /health', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await handle(request({ path: '/health', sourceIp: '203.0.113.9' }));
      assert.equal(response.status, 200);
    });

    it('blocks the webhook too', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await handle(
        request({ method: 'POST', path: '/webhooks/payment', sourceIp: '203.0.113.9', rawBody: '{}', body: {} }),
      );
      assert.equal(response.status, 403);
    });
  });
});
