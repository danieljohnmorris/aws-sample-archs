// Validity rules for a prescription, shared by the HTTP route and the SQS consumer.
import { query } from './db.mjs';

/** Upsert so a re-seed with new details wins, which is what the tests want. */
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
 * A prescription is valid when it exists, belongs to the customer, covers the
 * SKU and has not expired. Checks run in that order so the reason is the first
 * thing that is wrong.
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
