// Architecture B answers on a queue, so statuses arrive some time after the
// POST. Everything eventual goes through here with the same 30s ceiling.

export const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 30000);
const INTERVAL_MS = Number(process.env.E2E_POLL_INTERVAL_MS || 500);

/**
 * Calls `probe` until `accept` likes the answer. Throws on timeout with the
 * last value seen, which is what tells you whether the consumer ran at all.
 */
export async function pollUntil(probe, accept, description, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      lastError = null;
      if (accept(last)) return last;
    } catch (err) {
      lastError = err;
    }
    await sleep(INTERVAL_MS);
  }
  const detail = lastError ? `last error: ${lastError.message}` : `last value: ${JSON.stringify(last)}`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}. ${detail}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
