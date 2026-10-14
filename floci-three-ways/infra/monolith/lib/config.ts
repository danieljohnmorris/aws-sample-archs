/**
 * Shared constants for the Simplified monolith.
 *
 * One app, one database, one public API. The prescription check is a function
 * call inside the process, so there is nothing between the two halves to wire.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PREFIX = 'ftw-mono';
export const VPC_CIDR = '10.80.0.0/16';

export const APP_DIR = path.resolve(__dirname, '../../../apps/monolith');

export function assertAppReady(): void {
  const entry = path.join(APP_DIR, 'src', 'lambda.mjs');
  const modules = path.join(APP_DIR, 'node_modules', 'hono');
  if (!fs.existsSync(entry)) throw new Error(`${entry} is missing`);
  if (!fs.existsSync(modules)) throw new Error(`${APP_DIR}/node_modules is incomplete. Run make deps`);
}

export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000';
export const REGION = process.env.CDK_DEFAULT_REGION ?? 'eu-west-2';

export const FUNCTION_NAME = `${PREFIX}-app`;
export const LOG_GROUP = `/aws/lambda/${FUNCTION_NAME}`;
export const DB_NAME = 'shop';
export const STAGE_NAME = 'prod';

export function paymentWebhookSecret(): string {
  const value = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!value) throw new Error('PAYMENT_WEBHOOK_SECRET is not set. Add it to infra/monolith/.env');
  return value;
}

/** floci does not resolve {{resolve:secretsmanager:...}}, so the password is supplied at synth. See infra/c/NOTES.md. */
export function databasePassword(): string {
  const value = process.env.DB_PASSWORD;
  if (!value) throw new Error('DB_PASSWORD is not set. Add it to infra/monolith/.env');
  return value;
}

export const FLOCI_HOSTNAME = 'floci';
export const FLOCI_HOST_PORT = Number(process.env.FLOCI_PORT ?? 4606);

export function apiHostUrl(apiId: string): string {
  return `http://localhost:${FLOCI_HOST_PORT}/restapis/${apiId}/${STAGE_NAME}/_user_request_`;
}

export function databaseUrl(user: string, password: string, port: string, dbName: string): string {
  return `postgres://${user}:${password}@${FLOCI_HOSTNAME}:${port}/${dbName}`;
}
