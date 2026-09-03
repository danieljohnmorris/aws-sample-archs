import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as cfg from './config';
import { ssmString } from './ssm-param';

/** The ids an app stack needs from its base stack, read at deploy time. */
export interface BaseRefs {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly dbPort: string;
}

export function importBase(scope: Construct, service: cfg.Service): BaseRefs {
  const vpcId = ssmString(scope, 'VpcIdParam', cfg.paramName(service, 'vpc-id'));
  const subnet1 = ssmString(scope, 'AppSubnet1Param', cfg.paramName(service, 'app-subnet-1'));
  const subnet2 = ssmString(scope, 'AppSubnet2Param', cfg.paramName(service, 'app-subnet-2'));
  const appSgId = ssmString(scope, 'AppSgIdParam', cfg.paramName(service, 'app-sg-id'));
  const dbPort = ssmString(scope, 'DbPortParam', cfg.paramName(service, 'db-port'));

  const vpc = ec2.Vpc.fromVpcAttributes(scope, 'Vpc', {
    vpcId,
    // Fixed in cdk.json, so nothing here calls ec2:DescribeAvailabilityZones.
    availabilityZones: cfg.AZS,
    privateSubnetIds: [subnet1, subnet2],
  });

  const appSg = ec2.SecurityGroup.fromSecurityGroupId(scope, 'AppSg', appSgId, { mutable: false });

  return { vpc, appSg, dbPort };
}

export function importServiceRole(scope: Construct, service: cfg.Service): iam.IRole {
  return iam.Role.fromRoleArn(scope, 'ServiceRole', cfg.roleArn(service), { mutable: false });
}

/**
 * The Lambda asset for a service: the app directory zipped whole, node_modules
 * included, as the Makefile's deps target prepares it.
 */
export function serviceAssetDir(service: cfg.Service): string {
  const dir = path.resolve(__dirname, '..', '..', '..', 'apps', service);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    throw new Error(`${dir}/node_modules is missing. Run make deps first.`);
  }
  return dir;
}
