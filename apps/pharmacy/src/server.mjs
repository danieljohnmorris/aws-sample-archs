// node:http entrypoint for container mode. Also starts the architecture B
// consumer loop when its queue URL is set.
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { handle } from './app.mjs';
import { startConsumer, stopConsumer } from './consumer.mjs';
import { closePool } from './db.mjs';
import { logEvent } from './log.mjs';

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1_048_576);

/** Reads the request, calls handle(), writes the JSON response. */
export function createServer() {
  return createHttpServer(async (req, res) => {
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload_too_large' }));
      logEvent('warn', 'body rejected', { path: req.url, error: err.message });
      return;
    }

    const url = new URL(req.url || '/', 'http://placeholder');
    const query = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const response = await handle({
      method: (req.method || 'GET').toUpperCase(),
      path: url.pathname,
      query,
      headers: req.headers,
      body: parseJson(rawBody),
      rawBody,
      sourceIp: sourceIpOf(req),
    });

    const body = JSON.stringify(response.body ?? {});
    res.writeHead(response.status, {
      'content-type': 'application/json',
      ...(response.headers || {}),
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}

/**
 * Starts the HTTP listener and, in architecture B, the queue consumer.
 * Returns a handle with close() so tests can shut it down.
 */
export async function start(port = Number(process.env.PORT || 8080)) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Behind an ALB or API Gateway the real caller is the first x-forwarded-for entry. */
function sourceIpOf(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || '';
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
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
