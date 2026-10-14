import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import { databasePassword, DB_NAME, PREFIX, VPC_CIDR } from './config.js';

/**
 * A small VPC, one database, two security groups. No NAT gateway and no
 * internet gateway: the app talks to its own database and nothing else, and
 * Lambda's logs do not need a route out of the VPC.
 */
export class BaseStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly appSg: ec2.SecurityGroup;
  readonly db: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${PREFIX}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      maxAzs: 2,
      natGateways: 0,
      createInternetGateway: false,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 }],
    });

    this.appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      securityGroupName: 'app-sg',
      description: 'Monolith Lambda',
      allowAllOutbound: true,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      securityGroupName: 'db-sg',
      description: 'Monolith Postgres',
      allowAllOutbound: false,
    });
    // The only ingress rule in the architecture.
    dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), 'app to db');

    this.db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `${PREFIX}-${DB_NAME}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromPassword(DB_NAME, cdk.SecretValue.unsafePlainText(databasePassword())),
      allocatedStorage: 20,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: false,
      backupRetention: cdk.Duration.days(0),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'DbInstanceId', { value: this.db.instanceIdentifier });
  }
}
