// One pg Pool per process. Schema is created on first use, per CONTRACT.md.
import pg from 'pg';

let pool = null;
let schemaReady = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
     order_id text primary key,
     customer_id text,
     sku text,
     quantity int,
     prescription_id text,
     status text,
     reason text,
     created_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS processed_messages (
     idempotency_key text primary key,
     processed_at timestamptz
   )`,
];

/** Lazily built so importing the module never opens a socket. */
export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  });
  // Without a listener an idle client error takes the process down.
  pool.on('error', (err) => {
    process.stderr.write(`pg pool error: ${err.message}\n`);
  });
  return pool;
}

/** Runs the CREATE TABLE statements once per process. Concurrent callers share the promise. */
export function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const client = getPool();
    for (const statement of SCHEMA) await client.query(statement);
  })().catch((err) => {
    // Let the next request try again rather than caching the failure forever.
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** Every app query goes through here so the schema is always in place. */
export async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

/**
 * Claims an idempotency key. True the first time, false on every repeat.
 * Consumers use this to drop duplicate deliveries.
 */
export async function claimMessage(idempotencyKey) {
  const result = await query(
    `INSERT INTO processed_messages (idempotency_key, processed_at)
     VALUES ($1, now())
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [idempotencyKey],
  );
  return result.rowCount === 1;
}

/** Closes the pool. Tests and graceful shutdown use it. */
export async function closePool() {
  const open = pool;
  pool = null;
  schemaReady = null;
  if (open) await open.end();
}
