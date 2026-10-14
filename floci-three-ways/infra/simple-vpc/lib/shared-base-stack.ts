import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import { ALB_LISTENER_PORT, databasePassword, PHARMACY_CONTAINER_PORT, PREFIX, VPC_CIDR } from './config.js';

/**
 * One VPC, one NAT gateway, two databases, and the security groups that
 * decide who talks to whom. This is architecture C's network without its
 * identity layer: no interface endpoints, no IAM on the call, and one NAT for
 * the egress most teams keep.
 *
 * State lives here, so it carries termination protection and the databases
 * are RETAIN.
 */
export class SharedBaseStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly retailAppSg: ec2.SecurityGroup;
  readonly pharmacyAppSg: ec2.SecurityGroup;
  readonly pharmacyAlbSg: ec2.SecurityGroup;
  readonly retailDb: rds.DatabaseInstance;
  readonly pharmacyDb: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${PREFIX}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private-with-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    });

    const sg = (sgId: string, name: string, description: string, allowAllOutbound: boolean) =>
      new ec2.SecurityGroup(this, sgId, { vpc: this.vpc, securityGroupName: name, description, allowAllOutbound });

    this.retailAppSg = sg('RetailAppSg', 'retail-app-sg', 'Retail Lambda', true);
    this.pharmacyAppSg = sg('PharmacyAppSg', 'pharmacy-app-sg', 'Pharmacy Fargate tasks', true);
    this.pharmacyAlbSg = sg('PharmacyAlbSg', 'pharmacy-alb-sg', 'Internal ALB in front of pharmacy', true);
    const retailDbSg = sg('RetailDbSg', 'retail-db-sg', 'Retail Postgres', false);
    const pharmacyDbSg = sg('PharmacyDbSg', 'pharmacy-db-sg', 'Pharmacy Postgres', false);

    // The whole of the access control between the two services. Each rule
    // names a group. Being in retail-app-sg is what lets a caller reach pharmacy.
    this.pharmacyAlbSg.addIngressRule(this.retailAppSg, ec2.Port.tcp(ALB_LISTENER_PORT), 'retail app to pharmacy ALB');
    this.pharmacyAppSg.addIngressRule(this.pharmacyAlbSg, ec2.Port.tcp(PHARMACY_CONTAINER_PORT), 'pharmacy ALB to pharmacy tasks');
    retailDbSg.addIngressRule(this.retailAppSg, ec2.Port.tcp(5432), 'retail app to retail db');
    pharmacyDbSg.addIngressRule(this.pharmacyAppSg, ec2.Port.tcp(5432), 'pharmacy app to pharmacy db');

    this.retailDb = this.database('RetailDb', 'retail', retailDbSg);
    this.pharmacyDb = this.database('PharmacyDb', 'pharmacy', pharmacyDbSg);

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'RetailAppSgId', { value: this.retailAppSg.securityGroupId });
    new cdk.CfnOutput(this, 'PharmacyAlbSgId', { value: this.pharmacyAlbSg.securityGroupId });
  }

  private database(id: string, dbName: string, sg: ec2.SecurityGroup): rds.DatabaseInstance {
    return new rds.DatabaseInstance(this, id, {
      instanceIdentifier: `${PREFIX}-${dbName}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      databaseName: dbName,
      credentials: rds.Credentials.fromPassword(dbName, cdk.SecretValue.unsafePlainText(databasePassword())),
      allocatedStorage: 20,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: false,
      backupRetention: cdk.Duration.days(0),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
