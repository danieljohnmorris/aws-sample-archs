import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP, envSnapshot, truncate, useDatabase } from './helper.mjs';

describe('pharmacy handle()', { skip: SKIP }, () => {
  let handle;
  let query;
  let closePool;
  let restoreEnv;

  const nextYear = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const lastYear = () => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL', 'ALLOWED_CIDRS', 'SERVICE_NAME']);
    await useDatabase('ftw_pharmacy_app_test');
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ handle } = await import('../src/app.mjs'));
  });

  after(async () => {
    await closePool();
    restoreEnv();
  });

  beforeEach(async () => {
    delete process.env.ALLOWED_CIDRS;
    await truncate(query, ['prescriptions', 'processed_messages']);
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

  const seed = (overrides = {}) =>
    handle(
      request({
        method: 'POST',
        path: '/prescriptions',
        body: {
          prescriptionId: 'RX-1',
          customerId: 'c1',
          sku: 'RX-FOOD-1',
          expiresAt: nextYear(),
          ...overrides,
        },
      }),
    );

  const check = (id, customerId, sku) =>
    handle(request({ path: `/prescriptions/${id}/check`, query: { customerId, sku } }));

  it('answers /health', async () => {
    const response = await handle(request({ path: '/health' }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, service: 'pharmacy' });
    assert.equal(response.headers['content-type'], 'application/json');
  });

  it('echoes an inbound correlation id', async () => {
    const response = await handle(request({ headers: { 'X-Correlation-Id': 'abc-123' } }));
    assert.equal(response.headers['x-correlation-id'], 'abc-123');
  });

  it('generates a correlation id when none arrives', async () => {
    const response = await handle(request({}));
    assert.match(response.headers['x-correlation-id'], /^[0-9a-f-]{36}$/);
  });

  it('404s an unknown route', async () => {
    const response = await handle(request({ path: '/nope' }));
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'not_found');
  });

  it('seeds a prescription', async () => {
    const response = await seed();
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { prescriptionId: 'RX-1' });
    const rows = await query('SELECT customer_id, sku FROM prescriptions WHERE prescription_id = $1', ['RX-1']);
    assert.equal(rows.rows[0].customer_id, 'c1');
  });

  it('re-seeding overwrites the details', async () => {
    await seed();
    await seed({ customerId: 'c9' });
    const rows = await query('SELECT customer_id FROM prescriptions WHERE prescription_id = $1', ['RX-1']);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].customer_id, 'c9');
  });

  it('rejects a seed with fields missing', async () => {
    const response = await handle(request({ method: 'POST', path: '/prescriptions', body: { prescriptionId: 'RX-1' } }));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.missing, ['customerId', 'sku', 'expiresAt']);
  });

  it('rejects a seed with an unparseable expiry', async () => {
    const response = await seed({ expiresAt: 'not-a-date' });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, 'expiresAt');
  });

  it('rejects a check with no customerId or sku', async () => {
    await seed();
    const response = await handle(request({ path: '/prescriptions/RX-1/check', query: {} }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_request');
  });

  describe('validity rules', () => {
    it('is valid for the right customer, sku and an unexpired date', async () => {
      await seed();
      const response = await check('RX-1', 'c1', 'RX-FOOD-1');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { valid: true });
    });

    it('is invalid when the prescription does not exist', async () => {
      const response = await check('RX-MISSING', 'c1', 'RX-FOOD-1');
      assert.equal(response.status, 200);
      assert.equal(response.body.valid, false);
      assert.match(response.body.reason, /not found/);
    });

    it('is invalid for the wrong customer', async () => {
      await seed();
      const response = await check('RX-1', 'c2', 'RX-FOOD-1');
      assert.equal(response.body.valid, false);
      assert.match(response.body.reason, /customer/);
    });

    it('is invalid for the wrong sku', async () => {
      await seed();
      const response = await check('RX-1', 'c1', 'RX-OTHER-9');
      assert.equal(response.body.valid, false);
      assert.match(response.body.reason, /sku/);
    });

    it('is invalid when expired', async () => {
      await seed({ expiresAt: lastYear() });
      const response = await check('RX-1', 'c1', 'RX-FOOD-1');
      assert.equal(response.body.valid, false);
      assert.match(response.body.reason, /expired/);
    });

    it('reports the wrong customer before the wrong sku', async () => {
      await seed();
      const response = await check('RX-1', 'c2', 'RX-OTHER-9');
      assert.match(response.body.reason, /customer/);
    });
  });

  describe('allowlist', () => {
    it('lets an address inside the range through', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8, 203.0.113.7/32';
      const response = await handle(request({ path: '/prescriptions/RX-1/check', query: { customerId: 'c1', sku: 'x' }, sourceIp: '10.4.5.6' }));
      assert.equal(response.status, 200);
    });

    it('403s an address outside every range', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await handle(request({ path: '/prescriptions/RX-1/check', sourceIp: '192.168.1.9' }));
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'forbidden', sourceIp: '192.168.1.9' });
    });

    it('exempts /health', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await handle(request({ path: '/health', sourceIp: '192.168.1.9' }));
      assert.equal(response.status, 200);
    });

    it('is off when the variable is unset', async () => {
      delete process.env.ALLOWED_CIDRS;
      const response = await handle(request({ path: '/nope', sourceIp: '192.168.1.9' }));
      assert.equal(response.status, 404);
    });
  });
});
