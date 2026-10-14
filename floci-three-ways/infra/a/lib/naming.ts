/**
 * Names shared between the base stacks and the app stacks.
 *
 * The two sides never reference each other through CloudFormation exports.
 * Everything a base stack publishes goes into SSM, and the app stacks read it
 * back through an `AWS::SSM::Parameter::Value<String>` template parameter, so a
 * base stack can be updated without CloudFormation refusing the change because
 * an export is in use.
 *
 * A handful of names have to agree on both sides without a round trip through
 * SSM, because CDK needs them at synth time to build an ARN or a log group
 * reference. Those live here.
 */

export const PREFIX = 'ftw-a';

export type ServiceName = 'retail' | 'pharmacy';

/** SSM path for a value published by a base stack. */
export function ssmPath(service: ServiceName, key: string): string {
  return `/${PREFIX}/${service}/${key}`;
}

/** Lambda function name for retail. Fixed so the log group name is predictable. */
export const RETAIL_FUNCTION_NAME = `${PREFIX}-retail`;

/**
 * Retail logs to the group Lambda would create for itself. floci creates
 * `/aws/lambda/<function name>` on first invoke whether or not we asked for it,
 * so declaring the group under that exact name in the base stack is the only way
 * to own the retention setting rather than end up with two groups.
 */
export const RETAIL_LOG_GROUP_NAME = `/aws/lambda/${RETAIL_FUNCTION_NAME}`;

/** Pharmacy runs on ECS, so it gets a plain application path. */
export const PHARMACY_LOG_GROUP_NAME = `/${PREFIX}/pharmacy`;

export function logGroupName(service: ServiceName): string {
  return service === 'retail' ? RETAIL_LOG_GROUP_NAME : PHARMACY_LOG_GROUP_NAME;
}

/** Postgres database name per service. Also the RDS instance identifier suffix. */
export function databaseName(service: ServiceName): string {
  return service;
}

export function dbInstanceIdentifier(service: ServiceName): string {
  return `${PREFIX}-${service}`;
}
