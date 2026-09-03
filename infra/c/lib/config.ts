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

/** Where the two services live once they are on main. */
export const APPS_DIR = path.resolve(__dirname, '../../../apps');

export const HAVE_RETAIL_APP = fs.existsSync(path.join(APPS_DIR, 'retail', 'src', 'lambda.mjs'));
export const HAVE_PHARMACY_APP = fs.existsSync(path.join(APPS_DIR, 'pharmacy', 'Dockerfile'));

export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000';
export const REGION = process.env.CDK_DEFAULT_REGION ?? 'eu-west-1';

/** Execution role for the retail Lambda. Referenced by name from PharmacyApp. */
export const RETAIL_ROLE_NAME = `${PREFIX}-retail-lambda`;

/** Fallback identity, used only if floci does not evaluate the Lambda role. */
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
 * Both are the same for the placeholder and the real app. The security group
 * rule that names this port lives in SharedBase, and floci cannot update a
 * stack, so it has to be right before the apps land.
 */
export const PHARMACY_CONTAINER_PORT = 8080;
export const PHARMACY_HEALTH_PATH = '/health';

/** The real image once apps/pharmacy is on main, nginx standing in until then. */
export const PHARMACY_IMAGE = HAVE_PHARMACY_APP
  ? 'ftw-pharmacy:local'
  : 'public.ecr.aws/docker/library/nginx:alpine';

/**
 * Makes the placeholder answer on 8080 and serve the pharmacy health response
 * on every path, so the port and path stay the same when the app arrives.
 */
const PLACEHOLDER_NGINX_CONF = [
  'server {',
  `listen ${PHARMACY_CONTAINER_PORT};`,
  'default_type application/json;',
  `location / { return 200 '{"ok":true,"service":"pharmacy","placeholder":true}'; }`,
  '}',
].join(' ');

export const PHARMACY_PLACEHOLDER_COMMAND = [
  'sh',
  '-c',
  `printf '%s' ${JSON.stringify(PLACEHOLDER_NGINX_CONF)} > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'`,
];

export const STAGE_NAME = 'prod';

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
