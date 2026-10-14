// Order storage and the state transition a check result causes.
import { query } from './db.mjs';

export const PENDING = 'PENDING';
export const FULFILLED = 'FULFILLED';
export const REJECTED = 'REJECTED';

/** A SKU needs a prescription when it starts with RX-, per CONTRACT.md. */
export function needsPrescription(sku) {
  return typeof sku === 'string' && sku.startsWith('RX-');
}

export async function insertOrder({ orderId, customerId, sku, quantity, prescriptionId }) {
  await query(
    `INSERT INTO orders (order_id, customer_id, sku, quantity, prescription_id, status, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, now())`,
    [orderId, customerId, sku, quantity, prescriptionId ?? null, PENDING],
  );
}

export async function getOrder(orderId) {
  const result = await query(
    'SELECT order_id, customer_id, sku, quantity, prescription_id, status, reason FROM orders WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0] || null;
}

/** Moves an order out of PENDING. Returns the row as it now stands, or null when unknown. */
export async function setStatus(orderId, status, reason) {
  const result = await query(
    `UPDATE orders SET status = $2, reason = $3 WHERE order_id = $1
     RETURNING order_id, status, reason`,
    [orderId, status, reason ?? null],
  );
  return result.rows[0] || null;
}

/**
 * Turns a check answer into a status. Only touches orders still PENDING, so a
 * duplicate delivery that slips past the dedupe table cannot rewrite a decision.
 */
export async function applyCheckResult({ orderId, valid, reason }) {
  const status = valid ? FULFILLED : REJECTED;
  const result = await query(
    `UPDATE orders SET status = $2, reason = $3
     WHERE order_id = $1 AND status = $4
     RETURNING order_id, status, reason`,
    [orderId, status, valid ? null : (reason ?? 'prescription check failed'), PENDING],
  );
  if (result.rowCount === 1) {
    return { applied: true, order: result.rows[0] };
  }
  return { applied: false, order: await getOrder(orderId) };
}
