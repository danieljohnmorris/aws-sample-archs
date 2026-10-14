// The retail half: order rows and the status a check decides.
import { query } from './db.mjs';

export const PENDING = 'PENDING';
export const FULFILLED = 'FULFILLED';
export const REJECTED = 'REJECTED';

export function needsPrescription(sku) {
  return typeof sku === 'string' && sku.startsWith('RX-');
}

/** Inserts the order with its final status. There is no PENDING window to poll. */
export async function insertOrder({ orderId, customerId, sku, quantity, prescriptionId, status, reason }) {
  await query(
    `INSERT INTO orders (order_id, customer_id, sku, quantity, prescription_id, status, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [orderId, customerId, sku, quantity, prescriptionId ?? null, status, reason ?? null],
  );
}

export async function getOrder(orderId) {
  const result = await query(
    'SELECT order_id, customer_id, sku, quantity, prescription_id, status, reason FROM orders WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0] || null;
}
