import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface IpAllowlistProps {
  /** Used for the IP set name, the Web ACL name and the metric names. */
  readonly name: string;
  /** CIDRs the Web ACL allows. Everything else hits the default Block action. */
  readonly allowedCidrs: string[];
  /** API Gateway stage ARN to associate the Web ACL with. */
  readonly resourceArn: string;
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

    const ipSet = new wafv2.CfnIPSet(this, 'IpSet', {
      name: `${props.name}-allowlist`,
      description: `Addresses allowed to reach ${props.name}`,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: props.allowedCidrs,
    });

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
          statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
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

    const association = new wafv2.CfnWebACLAssociation(this, 'Association', {
      resourceArn: props.resourceArn,
      webAclArn: webAcl.attrArn,
    });
    association.addDependency(webAcl);

    this.ipSetArn = ipSet.attrArn;
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
