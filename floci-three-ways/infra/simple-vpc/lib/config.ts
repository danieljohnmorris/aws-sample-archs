/**
 * Shared constants for the Simplified one-VPC architecture.
 *
 * Two services in one VPC. Retail calls pharmacy over plain HTTP through an
 * internal ALB. The only thing that decides who may call is the security
 * group on that ALB. No IAM on the call, no SigV4, no EventBridge, no IP
 * allowlist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PREFIX = 'ftw-sv';
export const VPC_CIDR = '10.70.0.0/16';

export const APPS_DIR = path.resolve(__dirname, '../../../apps');
export const RETAIL_APP_DIR = path.join(APPS_DIR, 'retail');

export function assertRetailAppReady(): void {
  const entry = path.join(RETAIL_APP_DIR, 'src', 'lambda.mjs');
  const modules = path.join(RETAIL_APP_DIR, 'node_modules', 'hono');
  if (!fs.existsSync(entry)) throw new Error(`${entry} is missing`);
  if (!fs.existsSync(modules)) throw new Error(`${RETAIL_APP_DIR}/node_modules is incomplete. Run make deps`);
}

export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000';
export const REGION = process.env.CDK_DEFAULT_REGION ?? 'eu-west-2';

export const RETAIL_FUNCTION_NAME = `${PREFIX}-retail`;
export const RETAIL_LOG_GROUP = `/aws/lambda/${RETAIL_FUNCTION_NAME}`;

/** ALB listener port. Must sit inside the ftw-sv range 8110-8119. */
export const ALB_LISTENER_PORT = 8110;
export const PHARMACY_CONTAINER_PORT = 8080;
export const PHARMACY_HEALTH_PATH = '/health';
export const PHARMACY_IMAGE = 'ftw-pharmacy:local';
export const STAGE_NAME = 'prod';

export function paymentWebhookSecret(): string {
  const value = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!value) throw new Error('PAYMENT_WEBHOOK_SECRET is not set. Add it to infra/simple-vpc/.env');
  return value;
}

/** floci does not resolve {{resolve:secretsmanager:...}}, so the password is supplied at synth. See infra/c/NOTES.md. */
export function databasePassword(): string {
  const value = process.env.DB_PASSWORD;
  if (!value) throw new Error('DB_PASSWORD is not set. Add it to infra/simple-vpc/.env');
  return value;
}

export const FLOCI_HOSTNAME = 'floci';
export const FLOCI_HOST_PORT = Number(process.env.FLOCI_PORT ?? 4596);

export function apiHostUrl(apiId: string): string {
  return `http://localhost:${FLOCI_HOST_PORT}/restapis/${apiId}/${STAGE_NAME}/_user_request_`;
}

export function databaseUrl(user: string, password: string, port: string, dbName: string): string {
  return `postgres://${user}:${password}@${FLOCI_HOSTNAME}:${port}/${dbName}`;
}
