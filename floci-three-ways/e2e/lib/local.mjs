// ARCH=local. Both services run in this process, retail on 3001 and pharmacy
// on 3002, against two databases on one local Postgres. No floci, no stacks.
import net from 'node:net';
import pg from 'pg';

export const RETAIL_PORT = Number(process.env.LOCAL_RETAIL_PORT || 3001);
export const PHARMACY_PORT = Number(process.env.LOCAL_PHARMACY_PORT || 3002);
export const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'local-e2e-secret';

const DEFAULT_POSTGRES = 'postgres://postgres:pw@localhost:55432/postgres';
const RETAIL_DB = 'ftw_e2e_retail';
const PHARMACY_DB = 'ftw_e2e_pharmacy';

const APPS = new URL('../../apps/', import.meta.url);

/** The admin connection. DATABASE_URL wins, then POSTGRES_URL, then the default. */
export function postgresBaseUrl() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_POSTGRES;
}

function databaseUrl(name) {
  const url = new URL(postgresBaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** Creates the two databases if they are missing and drops any rows left behind. */
async function prepareDatabases() {
  const admin = new pg.Client({ connectionString: postgresBaseUrl(), connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `cannot reach Postgres at ${redact(postgresBaseUrl())}: ${err.message}\n` +
        'Start it with: docker run -d --name ftw-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine',
    );
  }
  try {
    for (const name of [RETAIL_DB, PHARMACY_DB]) {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Starts both services. Each app's db module caches its pool on first use, so
 * the schema is built while that service's DATABASE_URL is the one in the
 * environment, before the variable moves on to the other service.
 */
export async function startLocalStack() {
  await prepareDatabases();
  for (const port of [RETAIL_PORT, PHARMACY_PORT]) await assertPortFree(port);

  const savedEnv = snapshot([
    'DATABASE_URL',
    'PHARMACY_BASE_URL',
    'PAYMENT_WEBHOOK_SECRET',
    'ALLOWED_CIDRS',
    'CHECK_REQUEST_QUEUE_URL',
    'CHECK_RESULT_QUEUE_URL',
    'EVENT_BUS_NAME',
    'SIGN_REQUESTS',
    'PORT',
  ]);

  // Synchronous HTTP between the services, the architecture A wiring.
  delete process.env.CHECK_REQUEST_QUEUE_URL;
  delete process.env.CHECK_RESULT_QUEUE_URL;
  delete process.env.EVENT_BUS_NAME;
  delete process.env.SIGN_REQUESTS;
  delete process.env.ALLOWED_CIDRS;
  delete process.env.PORT;
  process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PHARMACY_BASE_URL = `http://localhost:${PHARMACY_PORT}`;

  process.env.DATABASE_URL = databaseUrl(PHARMACY_DB);
  const pharmacyDb = await import(new URL('pharmacy/src/db.mjs', APPS));
  await pharmacyDb.ensureSchema();
  await pharmacyDb.query('TRUNCATE prescriptions, processed_messages');
  const pharmacyServer = await import(new URL('pharmacy/src/server.mjs', APPS));
  const pharmacy = await pharmacyServer.start(PHARMACY_PORT);

  process.env.DATABASE_URL = databaseUrl(RETAIL_DB);
  const retailDb = await import(new URL('retail/src/db.mjs', APPS));
  await retailDb.ensureSchema();
  await retailDb.query('TRUNCATE orders, processed_messages');
  const retailServer = await import(new URL('retail/src/server.mjs', APPS));
  const retail = await retailServer.start(RETAIL_PORT);

  return {
    retailUrl: `http://localhost:${retail.port}`,
    pharmacyUrl: `http://localhost:${pharmacy.port}`,
    webhookSecret: WEBHOOK_SECRET,
    async stop() {
      await retail.close();
      await pharmacy.close();
      savedEnv();
    },
  };
}

const MONOLITH_DB = 'ftw_e2e_monolith';

/**
 * ARCH=monolith-local. One server on the retail port, one database. The
 * prescription check is a function call, so there is no pharmacy URL to set.
 */
export async function startLocalMonolith() {
  const admin = new pg.Client({ connectionString: postgresBaseUrl(), connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [MONOLITH_DB]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${MONOLITH_DB}"`);
  } finally {
    await admin.end();
  }
  await assertPortFree(RETAIL_PORT);
  const savedEnv = snapshot(['DATABASE_URL', 'PAYMENT_WEBHOOK_SECRET', 'PORT', 'SERVICE_NAME']);
  delete process.env.PORT;
  process.env.SERVICE_NAME = 'monolith';
  process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DATABASE_URL = databaseUrl(MONOLITH_DB);
  const db = await import(new URL('monolith/src/db.mjs', APPS));
  await db.ensureSchema();
  await db.query('TRUNCATE orders, prescriptions');
  const server = await import(new URL('monolith/src/server.mjs', APPS));
  const monolith = await server.start(RETAIL_PORT);
  const url = `http://localhost:${monolith.port}`;
  return {
    retailUrl: url,
    pharmacyUrl: url,
    webhookSecret: WEBHOOK_SECRET,
    async stop() {
      await monolith.close();
      savedEnv();
    },
  };
}

/** Ports 3001 and 3002 are fixed on purpose, so a clash is reported rather than dodged. */
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is in use. Stop whatever is listening on it and run again`));
      } else {
        reject(err);
      }
    });
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function snapshot(keys) {
  const saved = keys.map((key) => [key, process.env[key]]);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}
