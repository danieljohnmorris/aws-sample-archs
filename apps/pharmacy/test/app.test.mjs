import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP, envSnapshot, truncate, useDatabase } from './helper.mjs';

describe('pharmacy app', { skip: SKIP }, () => {
  let app;
  let query;
  let closePool;
  let restoreEnv;

  const nextYear = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const lastYear = () => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL', 'ALLOWED_CIDRS', 'SERVICE_NAME']);
    await useDatabase('ftw_pharmacy_app_test');
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ app } = await import('../src/app.mjs'));
  });

  after(async () => {
    await closePool();
    restoreEnv();
  });

  beforeEach(async () => {
    delete process.env.ALLOWED_CIDRS;
    await truncate(query, ['prescriptions', 'processed_messages']);
  });

  /**
   * Drives the Hono app the way the container entrypoint does: the caller's
   * address arrives on the socket, which @hono/node-server exposes as c.env.incoming.
   */
  const call = async (path, options = {}) => {
    const { method = 'GET', headers = {}, body, rawBody, sourceIp = '10.0.0.1' } = options;
    const init = { method, headers: { ...headers } };
    const raw = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    if (raw !== undefined) {
      init.body = raw;
      const named = Object.keys(init.headers).some((key) => key.toLowerCase() === 'content-type');
      if (!named) init.headers['content-type'] = 'application/json';
    }
    const response = await app.request(path, init, { incoming: { socket: { remoteAddress: sourceIp } } });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.json(),
    };
  };

  const seed = (overrides = {}) =>
    call('/prescriptions', {
      method: 'POST',
      body: {
        prescriptionId: 'RX-1',
        customerId: 'c1',
        sku: 'RX-FOOD-1',
        expiresAt: nextYear(),
        ...overrides,
      },
    });

  const check = (id, customerId, sku) =>
    call(`/prescriptions/${encodeURIComponent(id)}/check?customerId=${encodeURIComponent(customerId)}&sku=${encodeURIComponent(sku)}`);

  it('answers /health', async () => {
    const response = await call('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, service: 'pharmacy' });
    assert.equal(response.headers['content-type'], 'application/json');
  });

  it('echoes an inbound correlation id', async () => {
    const response = await call('/health', { headers: { 'X-Correlation-Id': 'abc-123' } });
    assert.equal(response.headers['x-correlation-id'], 'abc-123');
  });

  it('generates a correlation id when none arrives', async () => {
    const response = await call('/health');
    assert.match(response.headers['x-correlation-id'], /^[0-9a-f-]{36}$/);
  });

  it('404s an unknown route', async () => {
    const response = await call('/nope');
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'not_found');
    assert.equal(response.body.path, '/nope');
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
    const response = await call('/prescriptions', { method: 'POST', body: { prescriptionId: 'RX-1' } });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.missing, ['customerId', 'sku', 'expiresAt']);
  });

  it('rejects a seed whose body is not JSON', async () => {
    const response = await call('/prescriptions', { method: 'POST', rawBody: 'not json' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.missing, ['prescriptionId', 'customerId', 'sku', 'expiresAt']);
  });

  it('rejects a seed with an unparseable expiry', async () => {
    const response = await seed({ expiresAt: 'not-a-date' });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, 'expiresAt');
  });

  it('rejects a check with no customerId or sku', async () => {
    await seed();
    const response = await call('/prescriptions/RX-1/check');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_request');
  });

  it('reads the prescription id out of the path', async () => {
    await seed({ prescriptionId: 'RX/2' });
    const response = await check('RX/2', 'c1', 'RX-FOOD-1');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { valid: true });
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

    it('decodes an escaped query value', async () => {
      await seed({ sku: 'RX FOOD' });
      const response = await check('RX-1', 'c1', 'RX FOOD');
      assert.deepEqual(response.body, { valid: true });
    });
  });

  describe('allowlist', () => {
    it('lets an address inside the range through', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8, 203.0.113.7/32';
      const response = await call('/prescriptions/RX-1/check?customerId=c1&sku=x', { sourceIp: '10.4.5.6' });
      assert.equal(response.status, 200);
    });

    it('403s an address outside every range', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await call('/prescriptions/RX-1/check', { sourceIp: '192.168.1.9' });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'forbidden', sourceIp: '192.168.1.9' });
    });

    it('exempts /health', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await call('/health', { sourceIp: '192.168.1.9' });
      assert.equal(response.status, 200);
    });

    it('is off when the variable is unset', async () => {
      delete process.env.ALLOWED_CIDRS;
      const response = await call('/nope', { sourceIp: '192.168.1.9' });
      assert.equal(response.status, 404);
    });

    it('reads the caller from the first x-forwarded-for hop', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await call('/nope', {
        headers: { 'x-forwarded-for': '192.168.1.9, 10.0.0.1' },
        sourceIp: '10.0.0.1',
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.sourceIp, '192.168.1.9');
    });

    it('normalises an IPv4-mapped IPv6 socket address', async () => {
      process.env.ALLOWED_CIDRS = '10.0.0.0/8';
      const response = await call('/nope', { sourceIp: '::ffff:192.168.1.9' });
      assert.equal(response.status, 403);
      assert.equal(response.body.sourceIp, '192.168.1.9');
    });
  });
});
