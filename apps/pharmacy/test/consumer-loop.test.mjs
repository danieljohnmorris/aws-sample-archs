// The container-mode long-poll loop. Architecture B runs this in the ECS task
// instead of a Lambda event source mapping.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SKIP, envSnapshot, stubSqs, testRegion, truncate, useDatabase } from './helper.mjs';

describe('pharmacy consumer loop', { skip: SKIP }, () => {
  let startConsumer;
  let stopConsumer;
  let query;
  let closePool;
  let seedPrescription;
  let sqs;
  let restoreEnv;

  const requested = (orderId, customerId) =>
    JSON.stringify({
      type: 'PrescriptionCheckRequested',
      orderId,
      prescriptionId: 'RX-1',
      customerId,
      sku: 'RX-FOOD-1',
      idempotencyKey: orderId,
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
    await useDatabase('ftw_pharmacy_loop_test');
    sqs = await stubSqs();
    process.env.AWS_ENDPOINT_URL = sqs.endpoint;
    process.env.AWS_REGION = testRegion();
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.CHECK_RESULT_QUEUE_URL = `${sqs.endpoint}/000000000000/check-result`;
    ({ query, closePool } = await import('../src/db.mjs'));
    ({ seedPrescription } = await import('../src/prescriptions.mjs'));
    ({ startConsumer, stopConsumer } = await import('../src/consumer.mjs'));
  });

  after(async () => {
    await closePool();
    await sqs.close();
    restoreEnv();
  });

  it('does nothing when CHECK_REQUEST_QUEUE_URL is unset', () => {
    delete process.env.CHECK_REQUEST_QUEUE_URL;
    assert.equal(startConsumer(), null);
  });

  it('drains the queue and answers each request', async () => {
    process.env.CHECK_REQUEST_QUEUE_URL = `${sqs.endpoint}/000000000000/check-request`;
    await truncate(query, ['prescriptions', 'processed_messages']);
    await seedPrescription({
      prescriptionId: 'RX-1',
      customerId: 'c1',
      sku: 'RX-FOOD-1',
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    sqs.sent.length = 0;
    sqs.push({ Body: requested('loop-1', 'c1') });
    sqs.push({ Body: requested('loop-2', 'c2') });

    const loop = startConsumer();
    assert.ok(loop, 'the consumer did not start');
    try {
      await waitFor(() => sqs.sent.length === 2, 'two answers on the result queue');
    } finally {
      stopConsumer();
      await loop;
    }

    const answers = sqs.sent.map((message) => JSON.parse(message.MessageBody));
    assert.deepEqual(
      answers.map((answer) => [answer.orderId, answer.valid]),
      [
        ['loop-1', true],
        ['loop-2', false],
      ],
    );
    assert.match(answers[1].reason, /customer/);
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
