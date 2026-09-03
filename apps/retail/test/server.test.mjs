// The container entrypoint's body cap. No database, so this suite always runs:
// nothing here reaches a route that reads one.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { envSnapshot } from './helper.mjs';

describe('fetchWithBodyLimit', () => {
  let fetchWithBodyLimit;
  let restoreEnv;

  before(async () => {
    restoreEnv = envSnapshot(['MAX_BODY_BYTES']);
    // Read once at import, so it has to be set before the module loads.
    process.env.MAX_BODY_BYTES = '64';
    ({ fetchWithBodyLimit } = await import('../src/server.mjs'));
  });

  after(() => restoreEnv());

  const post = (body) =>
    fetchWithBodyLimit(
      new Request('http://localhost/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      {},
    );

  it('413s a body over the cap', async () => {
    const response = await post('x'.repeat(65));
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  });

  it('replays a body under the cap to the app', async () => {
    const response = await post('{"sku":"TEE-1"}');
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).missing, ['customerId', 'quantity']);
  });

  it('lets a request with no body through', async () => {
    const response = await fetchWithBodyLimit(new Request('http://localhost/health'), {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'retail' });
  });
});
