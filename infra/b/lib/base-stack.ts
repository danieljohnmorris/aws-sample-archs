import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as cfg from './config';

export interface BaseStackProps extends cdk.StackProps {
  readonly service: cfg.Service;
  /** Name of the CfnOutput carrying the VPC id, from the contract's output list. */
  readonly vpcOutputKey: string;
  readonly dbPassword: string;
}

/**
 * One VPC per side. No NAT gateways at all, so nothing in either VPC has a
 * route to the internet. Everything an app needs from AWS arrives through an
 * interface endpoint, and everything the two sides say to each other goes
 * through the queues in the messaging stack.
 */
export class BaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    const { service } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${cfg.PREFIX}-${service}`,
      ipAddresses: ec2.IpAddresses.cidr(cfg.VPC_CIDR[service]),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // The application security group. Nothing is allowed in; the RDS and
    // endpoint groups admit this group by id, never by CIDR.
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      securityGroupName: `${cfg.PREFIX}-${service}-app`,
      description: `${service} application tier`,
      allowAllOutbound: true,
    });

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc,
      securityGroupName: `${cfg.PREFIX}-${service}-endpoints`,
      description: `${service} interface VPC endpoints`,
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(appSg, ec2.Port.tcp(443), 'app tier to interface endpoints');

    // With no NAT, these three are the only AWS APIs either side can reach.
    const endpoints: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS],
      ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ];
    for (const [endpointId, awsService] of endpoints) {
      vpc.addInterfaceEndpoint(endpointId, {
        service: awsService,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      securityGroupName: `${cfg.PREFIX}-${service}-db`,
      description: `${service} database`,
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(5432), 'app tier to Postgres');

    // The password comes from infra/b/.env. floci is a local emulator and the
    // app stacks need to build DATABASE_URL at synth time; a generated secret
    // would only be readable through a CloudFormation dynamic reference, which
    // floci has not been shown to resolve.
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: cfg.DB_SECRET_NAME[service],
      description: `${service} Postgres credentials`,
      secretObjectValue: {
        username: cdk.SecretValue.unsafePlainText(cfg.DB_USER),
        password: cdk.SecretValue.unsafePlainText(props.dbPassword),
        dbname: cdk.SecretValue.unsafePlainText(cfg.DB_NAME[service]),
        engine: cdk.SecretValue.unsafePlainText('postgres'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `${cfg.PREFIX}-${service}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      // Not rds.Credentials.fromSecret: that adds a
      // AWS::SecretsManager::SecretTargetAttachment, and floci fails it with
      // "DB instance ftw-b-<service> not found" even once the instance is
      // available. The secret above holds the same credentials.
      credentials: rds.Credentials.fromPassword(cfg.DB_USER, cdk.SecretValue.unsafePlainText(props.dbPassword)),
      databaseName: cfg.DB_NAME[service],
      allocatedStorage: 20,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: true,
      deleteAutomatedBackups: false,
      backupRetention: cdk.Duration.days(1),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Owned here rather than by the app stack, so destroying the app stack
    // leaves the logs and their retention in place.
    const logGroup = new logs.LogGroup(this, 'ServiceLogGroup', {
      logGroupName: cfg.LOG_GROUP_NAME[service],
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const appSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
    const dataSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });

    // Everything an app stack needs from here. One parameter per subnet rather
    // than a comma-joined list, because the app stacks read them through
    // AWS::SSM::Parameter::Value<String> and that type is a single string.
    const params: Record<string, string> = {
      'vpc-id': vpc.vpcId,
      azs: appSubnets.availabilityZones.join(','),
      'app-subnet-1': appSubnets.subnetIds[0],
      'app-subnet-2': appSubnets.subnetIds[1],
      'data-subnet-1': dataSubnets.subnetIds[0],
      'data-subnet-2': dataSubnets.subnetIds[1],
      'app-sg-id': appSg.securityGroupId,
      'db-endpoint': db.instanceEndpoint.socketAddress,
      'db-port': db.dbInstanceEndpointPort,
      'db-secret-arn': dbSecret.secretArn,
      'log-group-name': logGroup.logGroupName,
    };
    for (const [key, value] of Object.entries(params)) {
      new ssm.StringParameter(this, `Param${key.replace(/(^|-)([a-z])/g, (_m, _d, c) => c.toUpperCase())}`, {
        parameterName: cfg.paramName(service, key),
        stringValue: value,
      });
    }

    new cdk.CfnOutput(this, props.vpcOutputKey, { key: props.vpcOutputKey, value: vpc.vpcId });
  }
}
