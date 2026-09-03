import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ALB_LISTENER_PORT, PHARMACY_CONTAINER_PORT, PREFIX } from './config.js';

/**
 * One VPC for both services, no NAT gateways, no CIDR-sourced ingress.
 *
 * Every rule in here names a security group as its source. The two databases
 * sit in isolated subnets. Anything the apps need from AWS arrives through a
 * VPC endpoint rather than an internet route.
 *
 * This stack holds the state the app stacks are allowed to lose. It carries
 * termination protection and the databases are RETAIN, so `cdk destroy` of the
 * app stacks leaves the data alone.
 */
export class SharedBaseStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly retailAppSg: ec2.SecurityGroup;
  readonly pharmacyAppSg: ec2.SecurityGroup;
  readonly pharmacyAlbSg: ec2.SecurityGroup;
  readonly retailDb: rds.DatabaseInstance;
  readonly pharmacyDb: rds.DatabaseInstance;
  readonly retailDbSecret: secretsmanager.Secret;
  readonly pharmacyDbSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    // No public subnets, so there is nowhere to put a NAT gateway and CDK
    // creates none. Egress to AWS goes through the endpoints below.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${PREFIX}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      // Nothing routes to an internet gateway here, so do not create one.
      createInternetGateway: false,
      subnetConfiguration: [
        { name: 'private-with-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    });

    // allowAllOutbound leaves a 0.0.0.0/0 egress rule. Ingress is what the
    // conformance test reads, and every ingress rule below names a group.
    this.retailAppSg = new ec2.SecurityGroup(this, 'RetailAppSg', {
      vpc: this.vpc,
      securityGroupName: 'retail-app-sg',
      description: 'Retail Lambda',
      allowAllOutbound: true,
    });

    this.pharmacyAppSg = new ec2.SecurityGroup(this, 'PharmacyAppSg', {
      vpc: this.vpc,
      securityGroupName: 'pharmacy-app-sg',
      description: 'Pharmacy Fargate tasks',
      allowAllOutbound: true,
    });

    this.pharmacyAlbSg = new ec2.SecurityGroup(this, 'PharmacyAlbSg', {
      vpc: this.vpc,
      securityGroupName: 'pharmacy-alb-sg',
      description: 'Internal ALB in front of pharmacy',
      allowAllOutbound: true,
    });

    const retailDbSg = new ec2.SecurityGroup(this, 'RetailDbSg', {
      vpc: this.vpc,
      securityGroupName: 'retail-db-sg',
      description: 'Retail Postgres',
      allowAllOutbound: false,
    });

    const pharmacyDbSg = new ec2.SecurityGroup(this, 'PharmacyDbSg', {
      vpc: this.vpc,
      securityGroupName: 'pharmacy-db-sg',
      description: 'Pharmacy Postgres',
      allowAllOutbound: false,
    });

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      securityGroupName: 'vpc-endpoint-sg',
      description: 'Interface endpoints',
      allowAllOutbound: false,
    });

    // The only ingress rules in this VPC. Each one names a group.
    this.pharmacyAlbSg.addIngressRule(
      this.retailAppSg,
      ec2.Port.tcp(80),
      'retail app to pharmacy ALB',
    );
    // The listener is on 8100 rather than 80 because floci publishes the ALB
    // on the host in the ftw-c range 8100-8109. The rule above is the one the
    // contract names; this is the one the listener would need on real AWS.
    this.pharmacyAlbSg.addIngressRule(
      this.retailAppSg,
      ec2.Port.tcp(ALB_LISTENER_PORT),
      'retail app to pharmacy ALB listener',
    );
    this.pharmacyAppSg.addIngressRule(
      this.pharmacyAlbSg,
      ec2.Port.tcp(PHARMACY_CONTAINER_PORT),
      'pharmacy ALB to pharmacy tasks',
    );
    retailDbSg.addIngressRule(this.retailAppSg, ec2.Port.tcp(5432), 'retail app to retail db');
    pharmacyDbSg.addIngressRule(this.pharmacyAppSg, ec2.Port.tcp(5432), 'pharmacy app to pharmacy db');
    endpointSg.addIngressRule(this.retailAppSg, ec2.Port.tcp(443), 'retail app to endpoints');
    endpointSg.addIngressRule(this.pharmacyAppSg, ec2.Port.tcp(443), 'pharmacy app to endpoints');

    for (const [name, service] of [
      ['Sqs', ec2.InterfaceVpcEndpointAwsService.SQS],
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['EventBridge', ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE],
      ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
    ] as const) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        securityGroups: [endpointSg],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
        open: false,
      });
    }

    // ECR image layers live in S3, so the gateway endpoint is not optional.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Retention is 30 days on every log group in this app. The app stacks own
    // their own groups so the names track the function and service names.
    new logs.LogGroup(this, 'PlatformLogGroup', {
      logGroupName: `/${PREFIX}/platform`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.retailDbSecret = this.dbSecret('RetailDbSecret', 'retail');
    this.pharmacyDbSecret = this.dbSecret('PharmacyDbSecret', 'pharmacy');
    this.retailDb = this.database('RetailDb', 'retail', retailDbSg, this.retailDbSecret);
    this.pharmacyDb = this.database('PharmacyDb', 'pharmacy', pharmacyDbSg, this.pharmacyDbSecret);

    // Ids that tests and later stacks read back without a CloudFormation import.
    const params: Array<[string, string]> = [
      ['vpc-id', this.vpc.vpcId],
      ['sg/retail-app', this.retailAppSg.securityGroupId],
      ['sg/pharmacy-app', this.pharmacyAppSg.securityGroupId],
      ['sg/pharmacy-alb', this.pharmacyAlbSg.securityGroupId],
      ['sg/retail-db', retailDbSg.securityGroupId],
      ['sg/pharmacy-db', pharmacyDbSg.securityGroupId],
      ['sg/vpc-endpoint', endpointSg.securityGroupId],
      ['db/retail-secret-arn', this.retailDbSecret.secretArn],
      ['db/pharmacy-secret-arn', this.pharmacyDbSecret.secretArn],
      ['db/retail-port', this.retailDb.dbInstanceEndpointPort],
      ['db/pharmacy-port', this.pharmacyDb.dbInstanceEndpointPort],
    ];
    for (const [name, value] of params) {
      new ssm.StringParameter(this, `Param${name.replace(/[^a-zA-Z0-9]/g, '')}`, {
        parameterName: `/${PREFIX}/${name}`,
        stringValue: value,
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'RetailAppSgId', { value: this.retailAppSg.securityGroupId });
    new cdk.CfnOutput(this, 'PharmacyAlbSgId', { value: this.pharmacyAlbSg.securityGroupId });
    new cdk.CfnOutput(this, 'PharmacyDbSgId', { value: pharmacyDbSg.securityGroupId });
  }

  /**
   * Master credentials, generated and held by us rather than by RDS.
   *
   * `Credentials.fromGeneratedSecret` adds a SecretTargetAttachment, and
   * floci's CloudFormation fails that resource with "DB instance ... not
   * found" even though the instance is `available` by then. Owning the secret
   * and passing the password in skips the attachment. See infra/c/NOTES.md.
   */
  private dbSecret(id: string, dbName: string): secretsmanager.Secret {
    return new secretsmanager.Secret(this, id, {
      secretName: `${PREFIX}/${dbName}/db`,
      description: `Master credentials for the ${dbName} database`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: dbName, dbname: dbName }),
        generateStringKey: 'password',
        passwordLength: 24,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\,=^',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /** Postgres 16 in the isolated tier, kept on stack deletion. */
  private database(
    id: string,
    dbName: string,
    sg: ec2.SecurityGroup,
    secret: secretsmanager.Secret,
  ): rds.DatabaseInstance {
    return new rds.DatabaseInstance(this, id, {
      instanceIdentifier: `${PREFIX}-${dbName}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      databaseName: dbName,
      credentials: rds.Credentials.fromPassword(dbName, secret.secretValueFromJson('password')),
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
