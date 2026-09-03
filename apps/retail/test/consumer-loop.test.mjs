// The container-mode long-poll loop. Architecture B runs this in the ECS task
// instead of a Lambda event source mapping.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SKIP, envSnapshot, stubSqs, testRegion, truncate, useDatabase } from './helper.mjs';

describe('retail consumer loop', { skip: SKIP }, () => {
  let startConsumer;
  let stopConsumer;
  let query;
  let closePool;
  let insertOrder;
  let getOrder;
  let sqs;
  let restoreEnv;

  const completed = (orderId) =>
    JSON.stringify({
      type: 'PrescriptionCheckCompleted',
      orderId,
      valid: true,
      reason: null,
      idempotencyKey: orderId,
    });

  before(async () => {
    restoreEnv = envSnapshot([
      'DATABASE_URL',
      'AWS_ENDPOINT_URL',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'CHECK_RESULT_QUEUE_URL',
    ]);
    await useDatabase('ftw_retail_loop_test');
    sqs = await stubSqs();
    process.env.AWS_ENDPOINT_URL = sqs.endpoint;
    process.env.AWS_REGION = testRegion();
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ insertOrder, getOrder } = await import('../src/orders.mjs'));
    ({ startConsumer, stopConsumer } = await import('../src/consumer.mjs'));
  });

  after(async () => {
    await closePool();
    await sqs.close();
    restoreEnv();
  });

  it('does nothing when CHECK_RESULT_QUEUE_URL is unset', () => {
    delete process.env.CHECK_RESULT_QUEUE_URL;
    assert.equal(startConsumer(), null);
  });

  it('drains the queue and applies the results', async () => {
    process.env.CHECK_RESULT_QUEUE_URL = `${sqs.endpoint}/000000000000/check-result`;
    await truncate(query, ['orders', 'processed_messages']);

    const orderIds = ['loop-1', 'loop-2'];
    for (const orderId of orderIds) {
      await insertOrder({ orderId, customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-1' });
      sqs.push({ Body: completed(orderId) });
    }

    const loop = startConsumer();
    assert.ok(loop, 'the consumer did not start');
    try {
      await waitFor(async () => {
        const statuses = await Promise.all(orderIds.map(async (id) => (await getOrder(id)).status));
        return statuses.every((status) => status === 'FULFILLED');
      }, 'both orders to be fulfilled');
    } finally {
      stopConsumer();
      await loop;
    }

    for (const orderId of orderIds) assert.equal((await getOrder(orderId)).status, 'FULFILLED');
  });
});

async function waitFor(check, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}
