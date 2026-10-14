// Needs DATABASE_URL pointing at a Postgres the test may create a database on.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const BASE = process.env.DATABASE_URL;
const DB = 'ftw_unit_monolith';

describe('monolith app', { skip: BASE ? false : 'DATABASE_URL is not set. docker run -d --name ftw-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine' }, () => {
  let app;
  let db;
  before(async () => {
    const admin = new pg.Client({ connectionString: BASE });
    await admin.connect();
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE "${DB}"`);
    await admin.end();
    const url = new URL(BASE);
    url.pathname = `/${DB}`;
    process.env.DATABASE_URL = url.toString();
    process.env.PAYMENT_WEBHOOK_SECRET = 'unit';
    db = await import('../src/db.mjs');
    await db.query('TRUNCATE orders, prescriptions');
    ({ app } = await import('../src/app.mjs'));
  });
  after(async () => {
    await db?.closePool();
    process.env.DATABASE_URL = BASE;
  });

  const send = async (method, path, json) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  it('answers one health check for the one process', async () => {
    assert.deepEqual((await send('GET', '/health')).body, { ok: true, service: 'monolith' });
  });

  it('decides a prescription order in the same request', async () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    assert.equal((await send('POST', '/prescriptions', { prescriptionId: 'RX-U', customerId: 'c1', sku: 'RX-A', expiresAt })).status, 201);
    const ok = await send('POST', '/orders', { customerId: 'c1', sku: 'RX-A', quantity: 1, prescriptionId: 'RX-U' });
    assert.equal(ok.body.status, 'FULFILLED');
    const no = await send('POST', '/orders', { customerId: 'c2', sku: 'RX-A', quantity: 1, prescriptionId: 'RX-U' });
    assert.equal(no.body.status, 'REJECTED');
    assert.match(no.body.reason, /customer/);
    assert.equal((await send('GET', `/orders/${no.body.orderId}`)).body.status, 'REJECTED');
  });

  it('rejects a bad webhook signature', async () => {
    const res = await app.request('/webhooks/payment', { method: 'POST', headers: { 'x-signature': 'ab' }, body: '{}' });
    assert.equal(res.status, 401);
  });
});
