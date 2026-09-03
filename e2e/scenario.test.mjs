// The end-to-end scenario from CONTRACT.md, run against ARCH=local, a, b or c.
//
//   make e2e ARCH=local   both services in this process, one local Postgres
//   make e2e ARCH=a|b|c   the deployed stacks, base URLs from outputs.json
//
// Steps 3 and 4 poll, because architecture B answers on a queue.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ARCH, IS_LOCAL, loadArchEnv, readOutputs, region, requireOutput } from './lib/config.mjs';
import { get, post } from './lib/http.mjs';
import { pollUntil, TIMEOUT_MS } from './lib/poll.mjs';

const RX_ID = 'RX-1';
const RX_SKU = 'RX-FOOD-1';
const PLAIN_SKU = 'TEE-1';

describe(`end to end, ARCH=${ARCH}`, () => {
  let retailUrl;
  let pharmacyUrl;
  let webhookSecret;
  let logGroup = null;
  let stack = null;
  let step3CorrelationId;

  before(async () => {
    if (IS_LOCAL) {
      const { startLocalStack } = await import('./lib/local.mjs');
      stack = await startLocalStack();
      ({ retailUrl, pharmacyUrl, webhookSecret } = stack);
      return;
    }
    await loadArchEnv(ARCH);
    const outputs = await readOutputs(ARCH);
    if (!outputs) {
      throw new Error(`infra/${ARCH}/outputs.json is missing. Run make deploy ARCH=${ARCH}`);
    }
    retailUrl = requireOutput(outputs, 'RetailApiUrl');
    pharmacyUrl = requireOutput(outputs, 'PharmacyApiUrl');
    logGroup = outputs.RetailLogGroup || null;
    webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error(`PAYMENT_WEBHOOK_SECRET is not set. Add it to infra/${ARCH}/.env`);
    }
  });

  after(async () => {
    if (stack) await stack.stop();
  });

  /** Waits for an order to leave PENDING. Architecture A and C are there already. */
  const settled = (orderId) =>
    pollUntil(
      async () => {
        const response = await get(retailUrl, `/orders/${orderId}`);
        assert.equal(response.status, 200, `GET /orders/${orderId} returned ${response.status}`);
        return response.body;
      },
      (order) => order.status !== 'PENDING',
      `order ${orderId} to leave PENDING`,
    );

  it('1. both services are healthy', async () => {
    const retail = await get(retailUrl, '/health');
    assert.equal(retail.status, 200);
    assert.deepEqual(retail.body, { ok: true, service: 'retail' });

    const pharmacy = await get(pharmacyUrl, '/health');
    assert.equal(pharmacy.status, 200);
    assert.deepEqual(pharmacy.body, { ok: true, service: 'pharmacy' });
  });

  it('2. seeds a prescription for c1', async () => {
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const response = await post(pharmacyUrl, '/prescriptions', {
      json: { prescriptionId: RX_ID, customerId: 'c1', sku: RX_SKU, expiresAt },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const check = await get(pharmacyUrl, `/prescriptions/${RX_ID}/check?customerId=c1&sku=${RX_SKU}`);
    assert.equal(check.status, 200);
    assert.equal(check.body.valid, true);
  });

  it('3. the prescription holder is fulfilled', async () => {
    step3CorrelationId = randomUUID();
    const created = await post(retailUrl, '/orders', {
      headers: { 'x-correlation-id': step3CorrelationId },
      json: { customerId: 'c1', sku: RX_SKU, quantity: 1, prescriptionId: RX_ID },
    });
    assert.ok([200, 201, 202].includes(created.status), `POST /orders returned ${created.status}`);
    assert.ok(created.body.orderId, 'no orderId in the response');

    const order = await settled(created.body.orderId);
    assert.equal(order.status, 'FULFILLED', `reason: ${order.reason}`);
  });

  it('4. another customer on the same prescription is rejected', async () => {
    const created = await post(retailUrl, '/orders', {
      json: { customerId: 'c2', sku: RX_SKU, quantity: 1, prescriptionId: RX_ID },
    });
    assert.ok([200, 201, 202].includes(created.status), `POST /orders returned ${created.status}`);

    const order = await settled(created.body.orderId);
    assert.equal(order.status, 'REJECTED');
    assert.match(order.reason, /customer/i);
  });

  it('5. a non-prescription sku is fulfilled straight away', async () => {
    const created = await post(retailUrl, '/orders', {
      json: { customerId: 'c1', sku: PLAIN_SKU, quantity: 3 },
    });
    assert.ok([200, 201].includes(created.status), `POST /orders returned ${created.status}`);
    assert.equal(created.body.status, 'FULFILLED');

    const order = await get(retailUrl, `/orders/${created.body.orderId}`);
    assert.equal(order.body.status, 'FULFILLED');
  });

  it('6. the payment webhook checks its signature', async () => {
    const rawBody = JSON.stringify({ event: 'payment.succeeded', amount: 4200, at: new Date().toISOString() });
    const signature = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');

    const bad = await post(retailUrl, '/webhooks/payment', {
      rawBody,
      headers: { 'x-signature': 'deadbeef'.repeat(8) },
    });
    assert.equal(bad.status, 401, JSON.stringify(bad.body));

    const good = await post(retailUrl, '/webhooks/payment', { rawBody, headers: { 'x-signature': signature } });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.deepEqual(good.body, { ok: true });
  });

  it(
    '7. the correlation id from step 3 reached CloudWatch Logs',
    {
      skip: IS_LOCAL
        ? 'ARCH=local runs in-process, so there is no CloudWatch log group'
        : false,
    },
    async () => {
      if (!logGroup) {
        assert.fail(`infra/${ARCH}/outputs.json has no RetailLogGroup, so step 7 cannot run`);
      }
      const { CloudWatchLogsClient, FilterLogEventsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
      const config = { endpoint: process.env.AWS_ENDPOINT_URL };
      if (region()) config.region = region();
      const client = new CloudWatchLogsClient(config);

      const found = await pollUntil(
        async () => {
          const answer = await client.send(
            new FilterLogEventsCommand({
              logGroupName: logGroup,
              filterPattern: `"${step3CorrelationId}"`,
              startTime: Date.now() - TIMEOUT_MS - 60000,
            }),
          );
          return answer.events || [];
        },
        (events) => events.length > 0,
        `a log line in ${logGroup} carrying ${step3CorrelationId}`,
      );

      assert.ok(found.length > 0);
      assert.ok(
        found.some((event) => event.message.includes(step3CorrelationId)),
        'the matched events do not contain the correlation id',
      );
      client.destroy();
    },
  );
});
