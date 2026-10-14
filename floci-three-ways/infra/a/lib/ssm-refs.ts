import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ServiceName, ssmPath } from './naming';

/**
 * Reading a base stack's published values back in an app stack.
 *
 * `ssm.StringParameter.valueForStringParameter` adds a template parameter of
 * type `AWS::SSM::Parameter::Value<String>`, which CloudFormation resolves at
 * deploy time. Nothing is read during synth, so a cold `cdk deploy --all` works
 * in one pass: the base stacks go first, write their parameters, and the app
 * stacks pick up real values when their turn comes.
 *
 * Subnet ids are published as one comma-joined String rather than a StringList.
 * floci does not resolve `AWS::SSM::Parameter::Value<List<String>>`; a template
 * parameter of that type comes back holding the parameter *name*. Measured
 * 2026-09-03, see NOTES.md. `Fn::Split` over a String parameter does work, so
 * that is what the readers below use.
 */

const AZ_COUNT = 2;

function read(scope: Construct, service: ServiceName, key: string): string {
  return ssm.StringParameter.valueForStringParameter(scope, ssmPath(service, key));
}

export interface BaseRefs {
  readonly vpc: ec2.IVpc;
  readonly appSecurityGroup: ec2.ISecurityGroup;
  readonly vpcId: string;
  readonly natEip: string;
  /** `<eip>/32`, the form WAF IP sets and the app allowlist both want. */
  readonly natEipCidr: string;
  readonly dbEndpointPort: string;
  readonly dbSecretArn: string;
  /**
   * Read on demand. Only retail reports it, and an unread template parameter is
   * a template parameter CloudFormation flags as unused.
   */
  readonly dbSecurityGroupId: string;
}

/** Everything an app stack needs from its own side's base stack. */
export function readBase(scope: Construct, service: ServiceName): BaseRefs {
  const vpcId = read(scope, service, 'vpc-id');
  const privateSubnetIds = cdk.Fn.split(',', read(scope, service, 'private-subnet-ids'), AZ_COUNT);
  const appSgId = read(scope, service, 'app-sg-id');
  const natEip = read(scope, service, 'nat-eip');

  const vpc = ec2.Vpc.fromVpcAttributes(scope, `${service}Vpc`, {
    vpcId,
    // The region is fixed by .env, so the zone names are known without a lookup.
    availabilityZones: [
      `${cdk.Stack.of(scope).region}a`,
      `${cdk.Stack.of(scope).region}b`,
    ],
    // Only the egress tier is handed out. Lambda, ECS tasks and the internal ALB
    // all sit there; nothing in an app stack belongs in a public or isolated subnet.
    privateSubnetIds,
  });

  return {
    vpc,
    vpcId,
    get dbSecurityGroupId() {
      // valueForStringParameter is keyed on the parameter name, so repeated
      // reads return the one template parameter rather than adding another.
      return read(scope, service, 'db-sg-id');
    },
    // Imported mutable, so CDK can add the load balancer to task ingress rule
    // as a standalone SecurityGroupIngress resource in the app stack. Declaring
    // allowAllOutbound stops it re-adding egress rules the base stack already has.
    appSecurityGroup: ec2.SecurityGroup.fromSecurityGroupId(scope, `${service}AppSg`, appSgId, {
      allowAllOutbound: true,
    }),
    natEip,
    natEipCidr: cdk.Fn.join('', [natEip, '/32']),
    dbEndpointPort: read(scope, service, 'db-endpoint-port'),
    dbSecretArn: read(scope, service, 'db-secret-arn'),
  };
}

/**
 * The other side's NAT elastic IP, and nothing else.
 *
 * This is the whole of architecture A's cross-VPC trust: retail decides whether
 * to answer pharmacy by looking at the address pharmacy's traffic leaves from.
 * The address therefore has to outlive any single app deployment, which is why
 * the EIP is allocated in the base stack and retained on delete. Tearing down
 * and redeploying RetailApp must not hand pharmacy a new address to allow.
 */
export function readPeerNatEip(scope: Construct, peer: ServiceName): { eip: string; cidr: string } {
  const eip = read(scope, peer, 'nat-eip');
  return { eip, cidr: cdk.Fn.join('', [eip, '/32']) };
}

/** The pharmacy HTTP API base URL, published by PharmacyApp for RetailApp to read. */
export function readPharmacyApiUrl(scope: Construct): string {
  return ssm.StringParameter.valueForStringParameter(scope, ssmPath('pharmacy', 'api-url'));
}
