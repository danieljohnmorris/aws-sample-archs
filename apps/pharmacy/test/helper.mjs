// Test plumbing: a real Postgres database per suite, plus small HTTP stubs for
// pharmacy and SQS so the outbound paths run for real without AWS.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';

export const SKIP =
  process.env.DATABASE_URL
    ? false
    : 'DATABASE_URL is not set. Start Postgres with:\n' +
      '  docker run -d --name ftw-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine\n' +
      '  export DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres';

/**
 * Creates `dbName` if it is missing and repoints DATABASE_URL at it, so the
 * suite never shares tables with the other service.
 */
export async function useDatabase(dbName) {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  return url.toString();
}

function adminUrl() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

/** Empties the tables between tests. Cheaper than dropping the database. */
export async function truncate(query, tables) {
  await query(`TRUNCATE ${tables.join(', ')}`);
}

/**
 * A pharmacy stand-in. `answers` maps prescriptionId to the JSON body to
 * return. Records every call so tests can assert on the query string.
 */
export async function stubPharmacy(answers = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const match = url.pathname.match(/^\/prescriptions\/([^/]+)\/check$/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }
    const answer = answers[decodeURIComponent(match[1])] ?? { valid: false, reason: 'prescription not found' };
    res.writeHead(answer.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body ?? answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Enough of the SQS JSON protocol for SendMessage, ReceiveMessage and
 * DeleteMessage. The SDK talks to it over AWS_ENDPOINT_URL like the real thing.
 */
export async function stubSqs() {
  const sent = [];
  let inbox = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] || '').split('.').pop();
      const payload = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      let body = {};
      if (target === 'SendMessage') {
        sent.push(payload);
        // The SDK verifies this digest and throws InvalidChecksumError otherwise.
        body = { MessageId: `stub-${sent.length}`, MD5OfMessageBody: md5(payload.MessageBody ?? '') };
      } else if (target === 'ReceiveMessage') {
        const batch = inbox.splice(0, payload.MaxNumberOfMessages || 10).map((message, index) => ({
          MessageId: message.MessageId || `stub-in-${index}`,
          ReceiptHandle: message.ReceiptHandle || `receipt-${index}`,
          Body: message.Body,
          MD5OfBody: md5(message.Body ?? ''),
          MessageAttributes: message.MessageAttributes,
        }));
        body = { Messages: batch };
      } else if (target === 'DeleteMessage') {
        body = {};
      } else {
        res.writeHead(400, { 'content-type': 'application/x-amz-json-1.0' });
        res.end(JSON.stringify({ __type: 'InvalidAction', message: target }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    sent,
    push: (message) => inbox.push(message),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/**
 * A region for the stub calls. Takes whatever the environment already says and
 * falls back to a placeholder, so no test pins a real region.
 */
export function testRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'test-region-1';
}

/** Restores process.env to a snapshot, so one test cannot leak into the next. */
export function envSnapshot(keys) {
  const saved = keys.map((key) => [key, process.env[key]]);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
