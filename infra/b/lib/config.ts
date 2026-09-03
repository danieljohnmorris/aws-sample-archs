/**
 * Names and derived ARNs shared by the five stacks in architecture B.
 *
 * Nothing here crosses stacks as a CloudFormation export. Every name is fixed,
 * so an ARN or a queue URL can be rebuilt in any stack from the name alone.
 * The values that cannot be predicted (VPC id, subnet ids, security group id,
 * the RDS port floci allocates) travel through SSM parameters written by the
 * base stacks and read back at synth time in bin/app.ts.
 */

export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000';
export const REGION = process.env.CDK_DEFAULT_REGION ?? 'eu-west-2';
export const PREFIX = 'ftw-b';

/** floci's own hostname on the compose network. Lambda and ECS containers use this. */
export const FLOCI_INTERNAL_ENDPOINT = 'http://floci:4566';

/** Host-side port for this architecture's floci, from infra/b/.env. */
export const FLOCI_HOST_PORT = process.env.FLOCI_PORT ?? '4576';

export type Service = 'retail' | 'pharmacy';

export const QUEUE = {
  checkRequest: `${PREFIX}-check-request`,
  checkRequestDlq: `${PREFIX}-check-request-dlq`,
  checkResult: `${PREFIX}-check-result`,
  checkResultDlq: `${PREFIX}-check-result-dlq`,
} as const;

export const ROLE_NAME = {
  retail: `${PREFIX}-retail-role`,
  pharmacy: `${PREFIX}-pharmacy-role`,
} as const;

export const USER_NAME = {
  retail: 'retail-svc',
  pharmacy: 'pharmacy-svc',
} as const;

export const SVC_SECRET_NAME = {
  retail: `${PREFIX}/retail-svc`,
  pharmacy: `${PREFIX}/pharmacy-svc`,
} as const;

export const DB_SECRET_NAME = {
  retail: `${PREFIX}/retail/db`,
  pharmacy: `${PREFIX}/pharmacy/db`,
} as const;

export const API_FUNCTION_NAME = {
  retail: `${PREFIX}-retail-api`,
  pharmacy: `${PREFIX}-pharmacy-api`,
} as const;

/** Base stacks own these, so they keep their retention when app stacks are destroyed. */
export const LOG_GROUP_NAME = {
  retail: `/aws/lambda/${API_FUNCTION_NAME.retail}`,
  pharmacy: `/aws/lambda/${API_FUNCTION_NAME.pharmacy}`,
} as const;

export const KMS_ALIAS = `alias/${PREFIX}-messaging`;

export const DB_NAME: Record<Service, string> = { retail: 'retail', pharmacy: 'pharmacy' };
export const DB_USER = 'appuser';

export const VPC_CIDR: Record<Service, string> = {
  retail: '10.10.0.0/16',
  pharmacy: '10.20.0.0/16',
};

export function queueArn(name: string): string {
  return `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`;
}

/**
 * floci returns queue URLs on its internal hostname, e.g.
 * http://floci:4566/000000000000/ftw-b-check-request. SDK clients on the host
 * still reach them because the endpoint override decides where the call goes.
 */
export function queueUrl(name: string): string {
  return `${FLOCI_INTERNAL_ENDPOINT}/${ACCOUNT}/${name}`;
}

export function roleArn(service: Service): string {
  return `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME[service]}`;
}

export function userArn(service: Service): string {
  return `arn:aws:iam::${ACCOUNT}:user/${USER_NAME[service]}`;
}

/**
 * SQS under floci's IAM enforcement resolves every request to the wildcard
 * queue ARN, so a statement naming one queue never matches. See the IAM
 * enforcement section of docs/day-one-floci-checks.md. Enforcement is
 * action-level for SQS; this is the narrowest resource that still allows.
 */
export const SQS_RESOURCE_UNDER_FLOCI = `arn:aws:sqs:${REGION}:${ACCOUNT}:*`;

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Export infra/b/.env before running cdk.`);
  }
  return value;
}

/**
 * floci advertises RDS on localhost:<port>. Lambda and ECS containers on the
 * compose network reach the same database as floci:<port>. The port is
 * allocated when the instance is created, so it arrives as a token.
 */
export function databaseUrl(service: Service, dbPort: string, password: string): string {
  return `postgresql://${DB_USER}:${encodeURIComponent(password)}@floci:${dbPort}/${DB_NAME[service]}`;
}

/** SSM parameter names the base stacks write and bin/app.ts reads back. */
export function paramName(service: Service, key: string): string {
  return `/${PREFIX}/${service}/${key}`;
}

/** Availability zones are pinned in cdk.json so no stack has to look them up. */
export const AZS = ['eu-west-2a', 'eu-west-2b'];

/** SSM parameter names for the pharmacy-svc access key, read by the app stack. */
export const SVC_KEY_PARAM = {
  accessKeyId: `/${PREFIX}/pharmacy-svc/access-key-id`,
  secretAccessKey: `/${PREFIX}/pharmacy-svc/secret-access-key`,
} as const;
