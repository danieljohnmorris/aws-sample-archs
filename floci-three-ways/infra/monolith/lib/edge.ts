import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/**
 * The customer edge: AWS managed common rules plus a rate limit, attached to
 * one REST API stage. Not an allowlist. Same shape as architecture C's edge.
 */
export function customerWebAcl(scope: Construct, name: string, restApiId: string, stageName: string): wafv2.CfnWebACL {
  const visibility = (metricName: string) => ({
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  });
  const webAcl = new wafv2.CfnWebACL(scope, 'WebAcl', {
    name,
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: visibility(name),
    rules: [
      {
        name: 'CommonRuleSet',
        priority: 0,
        overrideAction: { none: {} },
        statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
        visibilityConfig: visibility('CommonRuleSet'),
      },
      {
        name: 'RateLimit',
        priority: 1,
        action: { block: {} },
        statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
        visibilityConfig: visibility('RateLimit'),
      },
    ],
  });
  new wafv2.CfnWebACLAssociation(scope, 'WebAclAssociation', {
    webAclArn: webAcl.attrArn,
    resourceArn: cdk.Arn.format(
      { service: 'apigateway', account: '', resource: `/restapis/${restApiId}/stages/${stageName}` },
      cdk.Stack.of(scope),
    ),
  });
  return webAcl;
}
