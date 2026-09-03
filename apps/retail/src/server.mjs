// Container entrypoint. Serves the Hono app over node:http through
// @hono/node-server, and starts the architecture B consumer loop when its
// queue URL is set.
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { app } from './app.mjs';
import { startConsumer, stopConsumer } from './consumer.mjs';
import { closePool } from './db.mjs';
import { logEvent } from './log.mjs';

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1_048_576);

/**
 * Rejects an oversized body before the app reads it. The whole body is buffered
 * either way, so it is read here once and replayed to the app.
 */
export async function fetchWithBodyLimit(request, env) {
  if (!request.body) return app.fetch(request, env);

  let raw;
  try {
    raw = await readLimited(request);
  } catch (err) {
    const url = new URL(request.url);
    logEvent('warn', 'body rejected', { path: `${url.pathname}${url.search}`, error: err.message });
    return new Response(JSON.stringify({ error: 'payload_too_large' }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    });
  }

  const replayed = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: raw,
  });
  return app.fetch(replayed, env);
}

/**
 * Starts the HTTP listener and, in architecture B, the queue consumer.
 * Returns a handle with close() so tests can shut it down.
 */
export async function start(port = Number(process.env.PORT || 8080)) {
  let server;
  await new Promise((resolve, reject) => {
    server = serve({ fetch: fetchWithBodyLimit, port }, () => resolve());
    server.once('error', reject);
  });
  const actualPort = server.address().port;
  logEvent('info', 'listening', { port: actualPort });
  const consumer = startConsumer();
  return {
    server,
    port: actualPort,
    async close() {
      stopConsumer();
      await new Promise((resolve) => server.close(resolve));
      if (consumer) await consumer;
      await closePool();
    },
  };
}

async function readLimited(request) {
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`body over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const handle_ = await start();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      handle_.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
