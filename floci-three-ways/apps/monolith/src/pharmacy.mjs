// The pharmacy half. Same validity rules as apps/pharmacy/src/prescriptions.mjs,
// called as a function by the order route instead of over HTTP or a queue.
import { query } from './db.mjs';

export async function seedPrescription({ prescriptionId, customerId, sku, expiresAt }) {
  await query(
    `INSERT INTO prescriptions (prescription_id, customer_id, sku, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (prescription_id) DO UPDATE
       SET customer_id = EXCLUDED.customer_id,
           sku = EXCLUDED.sku,
           expires_at = EXCLUDED.expires_at`,
    [prescriptionId, customerId, sku, new Date(expiresAt)],
  );
}

/**
 * Valid when the prescription exists, belongs to the customer, covers the SKU
 * and has not expired. The first thing that is wrong is the reason.
 */
export async function checkPrescription({ prescriptionId, customerId, sku }) {
  const result = await query(
    'SELECT prescription_id, customer_id, sku, expires_at FROM prescriptions WHERE prescription_id = $1',
    [prescriptionId],
  );
  const row = result.rows[0];
  if (!row) return { valid: false, reason: 'prescription not found' };
  if (row.customer_id !== customerId) {
    return { valid: false, reason: 'prescription belongs to a different customer' };
  }
  if (row.sku !== sku) return { valid: false, reason: 'prescription does not cover this sku' };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'prescription expired' };
  }
  return { valid: true, reason: null };
}
