import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP, envSnapshot, stubSqs, testRegion, truncate, useDatabase } from './helper.mjs';

describe('pharmacy SQS consumer', { skip: SKIP }, () => {
  let handleRequestMessage;
  let sqsHandler;
  let query;
  let closePool;
  let seedPrescription;
  let sqs;
  let restoreEnv;

  const nextYear = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const requested = (overrides = {}) =>
    JSON.stringify({
      type: 'PrescriptionCheckRequested',
      orderId: 'order-1',
      prescriptionId: 'RX-1',
      customerId: 'c1',
      sku: 'RX-FOOD-1',
      idempotencyKey: 'order-1',
      ...overrides,
    });

  before(async () => {
    restoreEnv = envSnapshot([
      'DATABASE_URL',
      'AWS_ENDPOINT_URL',
      'AWS_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'CHECK_REQUEST_QUEUE_URL',
      'CHECK_RESULT_QUEUE_URL',
    ]);
    await useDatabase('ftw_pharmacy_consumer_test');
    sqs = await stubSqs();
    process.env.AWS_ENDPOINT_URL = sqs.endpoint;
    process.env.AWS_REGION = testRegion();
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.CHECK_RESULT_QUEUE_URL = `${sqs.endpoint}/000000000000/check-result`;
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ seedPrescription } = await import('../src/prescriptions.mjs'));
    ({ handleRequestMessage, sqsHandler } = await import('../src/consumer.mjs'));
  });

  after(async () => {
    await closePool();
    await sqs.close();
    restoreEnv();
  });

  beforeEach(async () => {
    sqs.sent.length = 0;
    await truncate(query, ['prescriptions', 'processed_messages']);
    await seedPrescription({
      prescriptionId: 'RX-1',
      customerId: 'c1',
      sku: 'RX-FOOD-1',
      expiresAt: nextYear(),
    });
  });

  it('answers a valid check on the result queue', async () => {
    const outcome = await handleRequestMessage(requested(), 'corr-1');
    assert.deepEqual(outcome, { answered: true, valid: true, reason: null });
    assert.equal(sqs.sent.length, 1);
    const reply = JSON.parse(sqs.sent[0].MessageBody);
    assert.deepEqual(reply, {
      type: 'PrescriptionCheckCompleted',
      orderId: 'order-1',
      valid: true,
      reason: null,
      idempotencyKey: 'order-1',
    });
    assert.equal(sqs.sent[0].QueueUrl, process.env.CHECK_RESULT_QUEUE_URL);
  });

  it('forwards the correlation id as a message attribute', async () => {
    await handleRequestMessage(requested(), 'corr-9');
    assert.equal(sqs.sent[0].MessageAttributes.correlationId.StringValue, 'corr-9');
  });

  it('answers an invalid check with a reason', async () => {
    const outcome = await handleRequestMessage(requested({ customerId: 'c2' }), 'corr-2');
    assert.equal(outcome.valid, false);
    assert.match(outcome.reason, /customer/);
    assert.equal(JSON.parse(sqs.sent[0].MessageBody).valid, false);
  });

  it('drops a duplicate delivery and sends nothing twice', async () => {
    const first = await handleRequestMessage(requested(), 'corr-3');
    assert.equal(first.answered, true);
    const second = await handleRequestMessage(requested(), 'corr-3');
    assert.deepEqual(second, { skipped: 'duplicate' });
    assert.equal(sqs.sent.length, 1);
  });

  it('treats two orders on one prescription as separate work', async () => {
    await handleRequestMessage(requested({ orderId: 'order-1', idempotencyKey: 'order-1' }), null);
    await handleRequestMessage(requested({ orderId: 'order-2', idempotencyKey: 'order-2' }), null);
    assert.equal(sqs.sent.length, 2);
  });

  it('ignores a message of the wrong type', async () => {
    const outcome = await handleRequestMessage(requested({ type: 'SomethingElse' }), null);
    assert.deepEqual(outcome, { skipped: 'type' });
    assert.equal(sqs.sent.length, 0);
  });

  it('rejects a message with no idempotency key', async () => {
    await assert.rejects(
      () => handleRequestMessage(JSON.stringify({ type: 'PrescriptionCheckRequested' }), null),
      /idempotencyKey/,
    );
  });

  it('releases the claim when the work throws, so a redelivery retries', async () => {
    const saved = process.env.CHECK_RESULT_QUEUE_URL;
    delete process.env.CHECK_RESULT_QUEUE_URL;
    await assert.rejects(() => handleRequestMessage(requested(), null), /CHECK_RESULT_QUEUE_URL/);
    const claims = await query('SELECT 1 FROM processed_messages WHERE idempotency_key = $1', ['order-1']);
    assert.equal(claims.rowCount, 0);

    process.env.CHECK_RESULT_QUEUE_URL = saved;
    const retry = await handleRequestMessage(requested(), null);
    assert.equal(retry.answered, true);
  });

  it('walks the Records array of a Lambda event', async () => {
    await sqsHandler({
      Records: [
        { body: requested({ orderId: 'order-a', idempotencyKey: 'order-a' }), messageAttributes: { correlationId: { stringValue: 'corr-a' } } },
        { body: requested({ orderId: 'order-b', idempotencyKey: 'order-b' }), messageAttributes: {} },
      ],
    });
    assert.equal(sqs.sent.length, 2);
    assert.deepEqual(
      sqs.sent.map((message) => JSON.parse(message.MessageBody).orderId),
      ['order-a', 'order-b'],
    );
  });
});
