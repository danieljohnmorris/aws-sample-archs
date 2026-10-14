import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * An id published by another stack, read at deploy time.
 *
 * floci does not resolve CloudFormation dynamic references: a property left as
 * "{{resolve:ssm:/name}}" arrives at the resource as that literal string. It
 * does resolve the AWS::SSM::Parameter::Value<String> parameter type, so that
 * is what the app stacks use. Measured on 2026-09-03; the probe is in
 * infra/b/NOTES.md.
 */
export function ssmString(scope: Construct, id: string, parameterName: string): string {
  const parameter = new cdk.CfnParameter(scope, id, {
    type: 'AWS::SSM::Parameter::Value<String>',
    default: parameterName,
    description: `Value of SSM parameter ${parameterName}`,
  });
  return parameter.valueAsString;
}
