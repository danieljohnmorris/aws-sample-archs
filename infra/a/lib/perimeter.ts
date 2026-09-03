import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface IpAllowlistProps {
  /** Used for the IP set name, the Web ACL name and the metric names. */
  readonly name: string;
  /** CIDRs the Web ACL allows. Everything else hits the default Block action. */
  readonly allowedCidrs: string[];
  /** API Gateway stage ARN to associate the Web ACL with. */
  readonly resourceArn: string;
  /**
   * Create the IP set and the stage association through the SDK instead of
   * through CloudFormation. Needed on floci, pointless on AWS. See the comment
   * on the shim in waf-shim/index.mjs.
   */
  readonly useSdkShim: boolean;
}

/**
 * One shim Lambda per stack, shared by every allowlist in it.
 *
 * Kept out of IpAllowlist so two allowlists in one stack do not each deploy a
 * copy of the same function.
 */
function wafShim(scope: Construct): lambda.IFunction {
  const stack = cdk.Stack.of(scope);
  const id = 'FlociWafShim';
  const existing = stack.node.tryFindChild(id) as lambda.Function | undefined;
  if (existing) return existing;

  const fn = new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    code: lambda.Code.fromAsset(path.resolve(__dirname, '../waf-shim')),
    handler: 'index.handler',
    timeout: cdk.Duration.minutes(2),
    description: 'Creates WAF IP sets and stage associations that floci CloudFormation does not',
  });

  // The shim reads and writes IP sets and associations across the account. WAF
  // v2 has no per-IP-set ARN to scope to before the set exists, so the actions
  // are named and the resource is not.
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'wafv2:CreateIPSet',
        'wafv2:UpdateIPSet',
        'wafv2:DeleteIPSet',
        'wafv2:GetIPSet',
        'wafv2:ListIPSets',
        'wafv2:AssociateWebACL',
        'wafv2:DisassociateWebACL',
        'wafv2:GetWebACLForResource',
      ],
      resources: ['*'],
    }),
  );
  return fn;
}

/**
 * A REGIONAL Web ACL that blocks by default and allows one IP set.
 *
 * floci stores WAF configuration and returns it through the API, but does not
 * filter traffic: a request from an address outside the set still gets through.
 * Measured 2026-09-03 and recorded in docs/day-one-floci-checks.md. The rules
 * are still declared, because the conformance tests read the configuration back
 * and assert on it, and because the same template is what would run on AWS.
 * The allowlist that can be watched rejecting a request is the one inside the
 * application, driven by ALLOWED_CIDRS.
 */
export class IpAllowlist extends Construct {
  public readonly ipSetArn: string;
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: IpAllowlistProps) {
    super(scope, id);

    const ipSetName = `${props.name}-allowlist`;
    const shim = props.useSdkShim ? wafShim(this) : undefined;

    let ipSetArn: string;
    if (shim) {
      const ipSet = new cdk.CustomResource(this, 'IpSetShim', {
        serviceToken: shim.functionArn,
        resourceType: 'Custom::FlociWafIpSet',
        properties: {
          Action: 'IpSet',
          Name: ipSetName,
          Scope: 'REGIONAL',
          Addresses: props.allowedCidrs,
        },
      });
      ipSetArn = ipSet.getAttString('Arn');
    } else {
      ipSetArn = new wafv2.CfnIPSet(this, 'IpSet', {
        name: ipSetName,
        description: `Addresses allowed to reach ${props.name}`,
        scope: 'REGIONAL',
        ipAddressVersion: 'IPV4',
        addresses: props.allowedCidrs,
      }).attrArn;
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.name}-acl`,
      description: `Default block for ${props.name}`,
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      rules: [
        {
          name: 'AllowListedAddresses',
          priority: 0,
          action: { allow: {} },
          statement: { ipSetReferenceStatement: { arn: ipSetArn } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.name}-allowlist`,
            sampledRequestsEnabled: true,
          },
        },
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${props.name}-acl`,
        sampledRequestsEnabled: true,
      },
    });

    if (shim) {
      new cdk.CustomResource(this, 'AssociationShim', {
        serviceToken: shim.functionArn,
        resourceType: 'Custom::FlociWafAssociation',
        properties: {
          Action: 'Associate',
          WebAclArn: webAcl.attrArn,
          ResourceArn: props.resourceArn,
        },
      });
    } else {
      const association = new wafv2.CfnWebACLAssociation(this, 'Association', {
        resourceArn: props.resourceArn,
        webAclArn: webAcl.attrArn,
      });
      association.addResourceDependency(webAcl);
    }

    this.ipSetArn = ipSetArn;
    this.webAclArn = webAcl.attrArn;
  }
}

/**
 * Postgres URL for a container talking to floci's RDS.
 *
 * floci reports the instance endpoint as `localhost:<port>`, which is right for
 * a client on the Docker host and wrong for anything inside a container: there
 * `localhost` is the container itself. floci proxies the same port on its own
 * container, reachable on the shared network as `floci`. So the host is
 * hard-coded and only the port is read back from the instance.
 *
 * On AWS the host would be the endpoint address. This is the one place where the
 * template says something floci-specific.
 */
export function containerDatabaseUrl(opts: {
  readonly port: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}): string {
  return `postgresql://${opts.username}:${opts.password}@floci:${opts.port}/${opts.database}`;
}

/**
 * The password held in an RDS-generated secret, as a CloudFormation dynamic
 * reference.
 *
 * The secret ARN arrives as a template parameter resolved from SSM, so the
 * usual `Secret.fromSecretCompleteArn` route is not open: CDK cannot tell a
 * complete ARN from a partial one when the value is a token. Fn::Sub builds the
 * same `{{resolve:secretsmanager:…}}` string CDK would have produced.
 */
export function secretJsonField(secretArn: string, field: string): string {
  return cdk.Fn.sub(`{{resolve:secretsmanager:\${SecretArn}:SecretString:${field}}}`, {
    SecretArn: secretArn,
  });
}

/**
 * floci's URLs for API Gateway stages.
 *
 * `localhost.floci.io` and everything under it resolve to 127.0.0.1 in public
 * DNS, which is what the Docker host needs, and floci's embedded resolver
 * answers the same names with its own address for the containers it launches.
 * One string therefore works from the host, from a Lambda and from an ECS task.
 *
 * The two API flavours are not served the same way, which the day-one notes did
 * not cover because only the v2 API was tested:
 *
 * - HTTP API (v2) answers on the virtual host, `<id>.execute-api.…`.
 * - REST API (v1) answers on a path, `/restapis/<id>/<stage>/_user_request_`.
 *   The virtual host form returns an S3 `NoSuchBucket` error instead, because
 *   floci matches the subdomain as a bucket name before it reaches API Gateway.
 *
 * Measured 2026-09-03, see NOTES.md.
 */
export function flociHttpApiUrl(apiId: string, flociPort: string): string {
  return `http://${apiId}.execute-api.localhost.floci.io:${flociPort}`;
}

export function flociRestApiUrl(apiId: string, stageName: string, flociPort: string): string {
  return `http://localhost.floci.io:${flociPort}/restapis/${apiId}/${stageName}/_user_request_`;
}
