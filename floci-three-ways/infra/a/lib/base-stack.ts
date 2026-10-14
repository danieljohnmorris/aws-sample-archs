import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  PREFIX,
  ServiceName,
  databaseName,
  dbInstanceIdentifier,
  logGroupName,
  ssmPath,
} from './naming';

export interface BaseStackProps extends cdk.StackProps {
  /** `retail` or `pharmacy`. Drives every name in the stack. */
  readonly service: ServiceName;
  /** VPC CIDR. The two VPCs do not overlap, and neither is peered. */
  readonly cidr: string;
  /**
   * Fixed database password. Set locally, because floci does not resolve
   * `{{resolve:secretsmanager:…}}` in a Lambda or task environment variable and
   * DATABASE_URL therefore has to carry the password itself. Left undefined on
   * AWS, where the password is generated and only the reference travels.
   */
  readonly dbPasswordValue?: string;
}

/**
 * The half of one side that outlives its application.
 *
 * Network, database and the public address the other side allows. An app stack
 * can be destroyed and rebuilt without any of this moving. That split is the
 * point of architecture A: the identity of a caller here *is* its NAT gateway
 * address, so if the address changed on every deploy the other side's allowlist
 * would be wrong every time.
 *
 * Nothing is exported through CloudFormation. Values go into SSM under
 * `/ftw-a/<service>/…` and the app stacks read them back. CloudFormation refuses
 * to update an export that another stack imports, which would make the base
 * stacks unchangeable while the app stacks are up.
 */
export class BaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    const { service, cidr } = props;

    // The NAT gateway's address is allocated here rather than left to CDK's
    // default NAT provider, for two reasons. It has to be readable so it can be
    // published to SSM, and it has to be retained on delete so the peer's
    // allowlist stays correct across an app stack teardown.
    const natEip = new ec2.CfnEIP(this, 'NatEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${PREFIX}-${service}-nat` }],
    });
    natEip.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [natEip.attrAllocationId],
      }),
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Leaving this on adds a custom resource backed by a Lambda that runs at
      // deploy time. It is one more moving part than this stack needs.
      restrictDefaultSecurityGroup: false,
    });

    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      securityGroupName: `${PREFIX}-${service}-app`,
      description: `${service} application tier`,
      allowAllOutbound: true,
    });

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      securityGroupName: `${PREFIX}-${service}-db`,
      description: `${service} database tier`,
      allowAllOutbound: false,
    });

    // The only ingress rule on the database. Sourced from a security group, not
    // a CIDR, so the conformance test can assert exactly one admitted source.
    dbSg.addIngressRule(
      appSg,
      ec2.Port.tcp(5432),
      'Postgres from the application security group',
    );

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: logGroupName(service),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The password is generated here rather than by `Credentials.fromGeneratedSecret`.
    // That helper makes CDK add an `AWS::SecretsManager::SecretTargetAttachment`,
    // and floci fails that resource with "DB instance ftw-a-<service> not found"
    // while `describe-db-instances` reports the same instance as available.
    // Measured 2026-09-03, see NOTES.md. `Credentials.fromPassword` produces no
    // attachment, so the secret holds the password and nothing else refers to it.
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `${PREFIX}/${service}/db`,
      description: `${service} Postgres credentials`,
      ...(props.dbPasswordValue
        ? {
            secretStringValue: cdk.SecretValue.unsafePlainText(
              JSON.stringify({
                username: 'postgres',
                password: props.dbPasswordValue,
                dbname: databaseName(service),
              }),
            ),
          }
        : {
            generateSecretString: {
              secretStringTemplate: JSON.stringify({
                username: 'postgres',
                dbname: databaseName(service),
              }),
              generateStringKey: 'password',
              passwordLength: 32,
              // Alphanumeric, so the password drops into DATABASE_URL unescaped.
              excludePunctuation: true,
            },
          }),
    });

    const db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: dbInstanceIdentifier(service),
      // Major version only. A pinned minor is a standing upgrade chore and
      // buys nothing here.
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('16', '16'),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromPassword(
        'postgres',
        props.dbPasswordValue
          ? cdk.SecretValue.unsafePlainText(props.dbPasswordValue)
          : dbSecret.secretValueFromJson('password'),
      ),
      databaseName: databaseName(service),
      allocatedStorage: 20,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(0),
      storageEncrypted: true,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const publish = (key: string, value: string, description: string) =>
      new ssm.StringParameter(this, `Param${key.replace(/[^a-zA-Z0-9]/g, '')}`, {
        parameterName: ssmPath(service, key),
        stringValue: value,
        description,
      });

    publish('vpc-id', this.vpc.vpcId, `${service} VPC`);
    // Comma-joined rather than a StringList parameter. floci does not resolve
    // `AWS::SSM::Parameter::Value<List<String>>`, so readers use Fn::Split over
    // a plain String. See NOTES.md.
    publish(
      'public-subnet-ids',
      this.vpc.publicSubnets.map((s) => s.subnetId).join(','),
      `${service} public subnets`,
    );
    publish(
      'private-subnet-ids',
      this.vpc.privateSubnets.map((s) => s.subnetId).join(','),
      `${service} private subnets with egress`,
    );
    publish(
      'isolated-subnet-ids',
      this.vpc.isolatedSubnets.map((s) => s.subnetId).join(','),
      `${service} isolated subnets`,
    );
    publish('app-sg-id', appSg.securityGroupId, `${service} application security group`);
    publish('db-sg-id', dbSg.securityGroupId, `${service} database security group`);
    publish('nat-eip', natEip.attrPublicIp, `${service} NAT gateway public address`);
    publish('db-endpoint-address', db.dbInstanceEndpointAddress, `${service} database host`);
    publish('db-endpoint-port', db.dbInstanceEndpointPort, `${service} database port`);
    publish('db-secret-arn', dbSecret.secretArn, `${service} database credentials`);
    publish('log-group-name', logGroup.logGroupName, `${service} log group`);
  }
}
