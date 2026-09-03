import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP, envSnapshot, truncate, useDatabase } from './helper.mjs';

describe('retail SQS consumer', { skip: SKIP }, () => {
  let handleResultMessage;
  let sqsHandler;
  let query;
  let closePool;
  let insertOrder;
  let getOrder;
  let restoreEnv;

  const completed = (overrides = {}) =>
    JSON.stringify({
      type: 'PrescriptionCheckCompleted',
      orderId: 'order-1',
      valid: true,
      reason: null,
      idempotencyKey: 'order-1',
      ...overrides,
    });

  const pendingOrder = (orderId) =>
    insertOrder({ orderId, customerId: 'c1', sku: 'RX-FOOD-1', quantity: 1, prescriptionId: 'RX-1' });

  before(async () => {
    restoreEnv = envSnapshot(['DATABASE_URL']);
    await useDatabase('ftw_retail_consumer_test');
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ insertOrder, getOrder } = await import('../src/orders.mjs'));
    ({ handleResultMessage, sqsHandler } = await import('../src/consumer.mjs'));
  });

  after(async () => {
    await closePool();
    restoreEnv();
  });

  beforeEach(async () => {
    await truncate(query, ['orders', 'processed_messages']);
  });

  it('fulfils a pending order', async () => {
    await pendingOrder('order-1');
    const outcome = await handleResultMessage(completed(), 'corr-1');
    assert.deepEqual(outcome, { applied: true, status: 'FULFILLED' });
    assert.equal((await getOrder('order-1')).status, 'FULFILLED');
  });

  it('rejects a pending order and stores the reason', async () => {
    await pendingOrder('order-1');
    await handleResultMessage(
      completed({ valid: false, reason: 'prescription belongs to a different customer' }),
      'corr-2',
    );
    const order = await getOrder('order-1');
    assert.equal(order.status, 'REJECTED');
    assert.match(order.reason, /customer/);
  });

  it('supplies a reason when an invalid result carries none', async () => {
    await pendingOrder('order-1');
    await handleResultMessage(completed({ valid: false, reason: null }), null);
    assert.equal((await getOrder('order-1')).reason, 'prescription check failed');
  });

  it('drops a duplicate delivery and leaves the decision alone', async () => {
    await pendingOrder('order-1');
    const first = await handleResultMessage(completed(), null);
    assert.equal(first.applied, true);

    const second = await handleResultMessage(completed({ valid: false, reason: 'late reversal' }), null);
    assert.deepEqual(second, { skipped: 'duplicate' });

    const order = await getOrder('order-1');
    assert.equal(order.status, 'FULFILLED');
    assert.equal(order.reason, null);
  });

  it('records the key exactly once', async () => {
    await pendingOrder('order-1');
    await handleResultMessage(completed(), null);
    await handleResultMessage(completed(), null);
    await handleResultMessage(completed(), null);
    const claims = await query('SELECT count(*)::int AS n FROM processed_messages WHERE idempotency_key = $1', ['order-1']);
    assert.equal(claims.rows[0].n, 1);
  });

  it('does not rewrite an order that already left PENDING', async () => {
    await pendingOrder('order-1');
    await handleResultMessage(completed({ valid: false, reason: 'first answer' }), null);
    const outcome = await handleResultMessage(completed({ idempotencyKey: 'order-1-retry', valid: true }), null);
    assert.equal(outcome.applied, false);
    assert.equal((await getOrder('order-1')).status, 'REJECTED');
  });

  it('reports no order when the id is unknown', async () => {
    const outcome = await handleResultMessage(completed({ orderId: 'ghost', idempotencyKey: 'ghost' }), null);
    assert.deepEqual(outcome, { applied: false, status: null });
  });

  it('falls back to orderId when idempotencyKey is absent', async () => {
    await pendingOrder('order-1');
    const message = JSON.parse(completed());
    delete message.idempotencyKey;
    await handleResultMessage(JSON.stringify(message), null);
    const claims = await query('SELECT 1 FROM processed_messages WHERE idempotency_key = $1', ['order-1']);
    assert.equal(claims.rowCount, 1);
  });

  it('ignores a message of the wrong type', async () => {
    await pendingOrder('order-1');
    const outcome = await handleResultMessage(completed({ type: 'SomethingElse' }), null);
    assert.deepEqual(outcome, { skipped: 'type' });
    assert.equal((await getOrder('order-1')).status, 'PENDING');
  });

  it('rejects a message with no key at all', async () => {
    await assert.rejects(
      () => handleResultMessage(JSON.stringify({ type: 'PrescriptionCheckCompleted', valid: true }), null),
      /idempotencyKey/,
    );
  });

  it('accepts an already parsed body', async () => {
    await pendingOrder('order-1');
    const outcome = await handleResultMessage(JSON.parse(completed()), null);
    assert.equal(outcome.applied, true);
  });

  it('walks the Records array of a Lambda event', async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await pendingOrder(id);
    await sqsHandler({
      Records: ids.map((id) => ({
        body: completed({ orderId: id, idempotencyKey: id }),
        messageAttributes: { correlationId: { stringValue: 'corr-batch' } },
      })),
    });
    for (const id of ids) assert.equal((await getOrder(id)).status, 'FULFILLED');
  });

  it('tolerates an event with no Records', async () => {
    assert.deepEqual(await sqsHandler({}), { batchItemFailures: [] });
  });
});
