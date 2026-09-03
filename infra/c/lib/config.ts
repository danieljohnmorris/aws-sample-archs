/**
 * Shared constants for architecture C.
 *
 * Callers are identified by IAM role, so a few names are fixed rather than
 * generated. PharmacyApp needs the retail role ARN for its resource policy and
 * RetailApp needs the pharmacy API URL, which would be a cycle if both sides
 * used CloudFormation exports. Fixing the role name breaks the cycle: the ARN
 * is built from the name, so only RetailApp depends on PharmacyApp.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Prefix on every named resource, matching the floci compose project. */
export const PREFIX = 'ftw-c';

/** The two services, built once against CONTRACT.md. */
export const APPS_DIR = path.resolve(__dirname, '../../../apps');

export const RETAIL_APP_DIR = path.join(APPS_DIR, 'retail');

/**
 * The Lambda asset is the app directory zipped whole, so `make deps` has to
 * have run. Fail at synth rather than at the first invoke.
 */
export function assertRetailAppReady(): void {
  const entry = path.join(RETAIL_APP_DIR, 'src', 'lambda.mjs');
  const modules = path.join(RETAIL_APP_DIR, 'node_modules', '@smithy', 'signature-v4');
  if (!fs.existsSync(entry)) throw new Error(`${entry} is missing`);
  if (!fs.existsSync(modules)) {
    throw new Error(`${RETAIL_APP_DIR}/node_modules is incomplete. Run make deps`);
  }
}

export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000';
export const REGION = process.env.CDK_DEFAULT_REGION ?? 'eu-west-2';

/** Execution role for the retail Lambda. Referenced by name from PharmacyApp. */
export const RETAIL_ROLE_NAME = `${PREFIX}-retail-lambda`;

/**
 * Long-lived identity carrying the same policy as the role.
 *
 * It exists because floci reports the Lambda's execution role but does not
 * evaluate it. Enable it with `-c useStaticKeys=true`, and read the caveat in
 * infra/c/NOTES.md first: floci resolves events:PutEvents to the wildcard
 * resource, so this identity is denied the one call retail has to make.
 */
export const RETAIL_USER_NAME = `${PREFIX}-retail-svc`;

export const RETAIL_FUNCTION_NAME = `${PREFIX}-retail`;
export const RETAIL_LOG_GROUP = `/aws/lambda/${RETAIL_FUNCTION_NAME}`;

export const EVENT_BUS_NAME = 'orders';
export const EVENT_RULE_NAME = 'order-events';

/** ALB listener port. Must sit inside the ftw-c range 8100-8109. */
export const ALB_LISTENER_PORT = 8100;

/**
 * Port the pharmacy container listens on, and the path the ALB probes.
 *
 * The security group rule that names this port lives in SharedBase, and floci
 * cannot update a stack, so changing it means rebuilding the base.
 */
export const PHARMACY_CONTAINER_PORT = 8080;
export const PHARMACY_HEALTH_PATH = '/health';

/** Built by `make images` from apps/pharmacy. */
export const PHARMACY_IMAGE = 'ftw-pharmacy:local';

export const STAGE_NAME = 'prod';

/**
 * HMAC secret for the payment webhook. It comes from infra/c/.env so the
 * deployed secret and the value the e2e test signs with cannot drift; the
 * stack copies it into Secrets Manager and the Lambda reads it back from there.
 */
export function paymentWebhookSecret(): string {
  const value = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!value) throw new Error('PAYMENT_WEBHOOK_SECRET is not set. Add it to infra/c/.env');
  return value;
}

/**
 * Master password for both databases, also from infra/c/.env.
 *
 * floci's CloudFormation does not resolve `{{resolve:secretsmanager:...}}`, so
 * a generated secret arrives in the Lambda environment as the literal
 * placeholder text and every connection fails. The value is supplied at synth
 * instead, and still written to Secrets Manager so the role that may read it
 * is part of the design. See infra/c/NOTES.md.
 */
export function databasePassword(): string {
  const value = process.env.DB_PASSWORD;
  if (!value) throw new Error('DB_PASSWORD is not set. Add it to infra/c/.env');
  return value;
}

/**
 * floci listens on 4566 inside its own network and is published on FLOCI_PORT
 * on the host. Anything a container calls uses 4566; anything the host or a
 * test calls uses FLOCI_PORT.
 */
export const FLOCI_INTERNAL_PORT = 4566;
export const FLOCI_HOST_PORT = Number(process.env.FLOCI_PORT ?? 4586);

/** Hostname of floci from inside the ftw-c_default network. */
export const FLOCI_HOSTNAME = 'floci';

/**
 * How floci serves an API stage.
 *
 * The `<id>.execute-api.localhost.floci.io` form only works for HTTP APIs, and
 * only where the caller's resolver answers `localhost.floci.io`, which a plain
 * container on the network does not. The `_user_request_` path form works for
 * REST and HTTP APIs, from the host, from a plain container and from a
 * floci-managed container, so both URLs below use it.
 */
export function apiHostUrl(apiId: string): string {
  return `http://localhost:${FLOCI_HOST_PORT}/restapis/${apiId}/${STAGE_NAME}/_user_request_`;
}

export function apiInternalUrl(apiId: string): string {
  return `http://${FLOCI_HOSTNAME}:${FLOCI_INTERNAL_PORT}/restapis/${apiId}/${STAGE_NAME}/_user_request_`;
}

/**
 * Upstream the API Gateway integration calls.
 *
 * The ALB DNS name `<name>.elb.floci` is what a floci-managed container
 * resolves, and it is what the REST integration below is pointed at because
 * that is the real design. floci's own HTTP client does not resolve it, so the
 * HTTP API integration that actually carries traffic uses floci's own hostname
 * and the published listener port instead.
 */
export function albUpstream(): string {
  return `http://${FLOCI_HOSTNAME}:${ALB_LISTENER_PORT}`;
}

/**
 * Postgres URL as seen from inside the network. floci publishes RDS on the
 * host as localhost:<port>, so containers reach the same database at floci:<port>.
 */
export function databaseUrl(user: string, password: string, port: string, dbName: string): string {
  return `postgres://${user}:${password}@${FLOCI_HOSTNAME}:${port}/${dbName}`;
}
