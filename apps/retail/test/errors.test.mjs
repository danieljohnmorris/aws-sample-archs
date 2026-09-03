// The 500 path. DATABASE_URL points at a port with nothing on it, so the route
// throws for real and no live database is needed.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { envSnapshot } from './helper.mjs';

describe('an unhandled failure', () => {
  let app;
  let restoreEnv;

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL', 'ALLOWED_CIDRS', 'PG_CONNECT_TIMEOUT_MS']);
    delete process.env.ALLOWED_CIDRS;
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/nowhere';
    process.env.PG_CONNECT_TIMEOUT_MS = '2000';
    ({ app } = await import('../src/app.mjs'));
  });

  after(async () => {
    const { closePool } = await import('../src/db.mjs');
    await closePool();
    restoreEnv();
  });

  it('answers 500 with the correlation id still on it', async () => {
    const response = await app.request('/orders/abc', { headers: { 'x-correlation-id': 'corr-500' } });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-correlation-id'), 'corr-500');
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  });

  it('still answers /health, which touches no database', async () => {
    const response = await app.request('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'retail' });
  });
});
