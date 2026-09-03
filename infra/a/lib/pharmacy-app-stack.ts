import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PHARMACY_LOG_GROUP_NAME, PREFIX, databaseName, ssmPath } from './naming';
import {
  IpAllowlist,
  containerDatabaseUrl,
  flociHttpApiUrl,
  secretJsonField,
} from './perimeter';
import { readBase, readPeerNatEip } from './ssm-refs';

export interface PharmacyAppStackProps extends cdk.StackProps {
  /** Container image. `ftw-pharmacy:local` once apps/pharmacy exists. */
  readonly image: string;
  /** Port the image listens on. nginx serves 80; the contract's server.mjs uses 8080. */
  readonly containerPort: number;
  /** Overrides for the placeholder image, so `/health` answers 200. */
  readonly entryPoint?: string[];
  readonly command?: string[];
  /** ALB listener port. Must be inside the 8080-8089 range compose publishes. */
  readonly albPort: number;
  /**
   * Host the HTTP API's HTTP_PROXY integration dials. Defaults to the load
   * balancer's DNS name, which is what AWS wants and what floci cannot resolve.
   */
  readonly albIntegrationHost?: string;
  /** floci's edge port, 4566 for architecture A. */
  readonly flociPort: string;
  /** Region, for the task environment. Lambda gets it from the runtime. */
  readonly awsRegion: string;
  /** See IpAllowlistProps.useSdkShim. */
  readonly useWafSdkShim: boolean;
  /**
   * Fixed database password, matching the one PharmacyBase gave the instance.
   * Undefined on AWS, where the reference below resolves instead.
   */
  readonly dbPasswordValue?: string;
}

/**
 * Pharmacy on ECS Fargate, behind an internal ALB, fronted by an HTTP API.
 *
 * Retail reaches this through the HTTP API only. The perimeter is two layers:
 * a Web ACL on the API stage that blocks everything except retail's NAT address,
 * and the allowlist inside the application driven by ALLOWED_CIDRS. Only the
 * second one can be seen rejecting anything under floci.
 */
export class PharmacyAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PharmacyAppStackProps) {
    super(scope, id, props);

    const base = readBase(this, 'pharmacy');

    // Retail's address comes from RetailBase, not RetailApp. Destroying and
    // rebuilding RetailApp must not change who pharmacy trusts, so the elastic
    // IP is allocated and retained one stack down.
    const retail = readPeerNatEip(this, 'retail');

    const logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroup', PHARMACY_LOG_GROUP_NAME);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: base.vpc,
      clusterName: `${PREFIX}-pharmacy`,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${PREFIX}-pharmacy`,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDefinition.addContainer('pharmacy', {
      image: ecs.ContainerImage.fromRegistry(props.image),
      entryPoint: props.entryPoint,
      command: props.command,
      portMappings: [{ containerPort: props.containerPort, protocol: ecs.Protocol.TCP }],
      environment: {
        SERVICE_NAME: 'pharmacy',
        PORT: String(props.containerPort),
        // Retail's NAT address, plus loopback because floci reports every caller
        // through API Gateway as 127.0.0.1, plus the private range the Docker
        // network sits in so a call arriving direct from a container is not
        // rejected on its own source address.
        ALLOWED_CIDRS: `${retail.cidr},127.0.0.1/32,172.16.0.0/12`,
        DATABASE_URL: containerDatabaseUrl({
          port: base.dbEndpointPort,
          database: databaseName('pharmacy'),
          username: 'postgres',
          // floci passes `{{resolve:secretsmanager:…}}` into a task environment
          // variable verbatim. Measured 2026-09-03, see NOTES.md.
          password: props.dbPasswordValue ?? secretJsonField(base.dbSecretArn, 'password'),
        }),
        // floci injects all three into a Lambda and none of them into a task.
        // The SDK v3 environment credential and region providers read AWS_REGION,
        // not AWS_DEFAULT_REGION, so both are set.
        AWS_ENDPOINT_URL: `http://floci:${props.flociPort}`,
        AWS_REGION: props.awsRegion,
        AWS_DEFAULT_REGION: props.awsRegion,
      },
      // floci records the log configuration and stores nothing through it. The
      // group is still declared and named so the template matches what AWS would
      // run, and so retention is owned by the base stack rather than defaulted.
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'pharmacy' }),
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: `${PREFIX}-pharmacy`,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [base.appSecurityGroup],
      // No circuit breaker or minimum healthy percent games. One task.
      minHealthyPercent: 0,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: base.vpc,
      loadBalancerName: `${PREFIX}-pharmacy`,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const listener = alb.addListener('Http', {
      port: props.albPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      // `open: true` would put an 0.0.0.0/0 ingress rule on the load balancer.
      // The only caller is API Gateway, so the rule is written by hand below.
      open: false,
    });

    alb.connections.allowFrom(
      base.appSecurityGroup,
      ec2.Port.tcp(props.albPort),
      'API Gateway proxy and in-VPC callers',
    );

    listener.addTargets('Tasks', {
      port: props.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${PREFIX}-pharmacy`,
      description: 'Pharmacy edge. HTTP_PROXY straight at the internal ALB.',
    });

    // On AWS an HTTP API reaching an internal ALB needs a VPC Link. floci has one
    // flat Docker network, so a plain HTTP_PROXY integration is enough here.
    //
    // The host is not the load balancer's DNS name, though the day-one notes
    // suggested it could be. floci's embedded resolver answers `<name>.elb.floci`
    // for the containers floci launches, and floci runs HTTP_PROXY integrations
    // itself, from a container using Docker's own resolver. So the name does not
    // resolve where it has to and the integration returns 502 with
    // `HTTP_PROXY backend call failed: null` in the floci log. floci publishes the
    // listener on its own address, so `floci:<port>` reaches the same listener.
    // Measured 2026-09-03, see NOTES.md.
    const albHost = props.albIntegrationHost ?? alb.loadBalancerDnsName;
    const albTarget = `http://${albHost}:${props.albPort}`;

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpUrlIntegration('AlbProxy', `${albTarget}/{proxy}`),
    });
    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpUrlIntegration('AlbRoot', `${albTarget}/`),
    });

    const stageName = httpApi.defaultStage!.stageName;
    const stageArn = `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/apis/${httpApi.apiId}/stages/${stageName}`;

    const perimeter = new IpAllowlist(this, 'Perimeter', {
      name: `${PREFIX}-pharmacy`,
      allowedCidrs: [retail.cidr, '127.0.0.1/32'],
      resourceArn: stageArn,
      useSdkShim: props.useWafSdkShim,
    });

    const apiUrl = flociHttpApiUrl(httpApi.apiId, props.flociPort);

    // Retail reads this to build PHARMACY_BASE_URL. Published rather than
    // exported, so PharmacyApp can be replaced without CloudFormation blocking
    // the change on an import.
    new ssm.StringParameter(this, 'ParamApiUrl', {
      parameterName: ssmPath('pharmacy', 'api-url'),
      stringValue: apiUrl,
      description: 'Pharmacy HTTP API base URL',
    });

    new cdk.CfnOutput(this, 'PharmacyApiUrl', { value: apiUrl });
    new cdk.CfnOutput(this, 'PharmacyRestApiId', { value: httpApi.apiId });
    new cdk.CfnOutput(this, 'PharmacyWebAclArn', { value: perimeter.webAclArn });
    new cdk.CfnOutput(this, 'PharmacyIpSetArn', { value: perimeter.ipSetArn });
    new cdk.CfnOutput(this, 'PharmacyVpcId', { value: base.vpcId });
    new cdk.CfnOutput(this, 'PharmacyNatEip', { value: base.natEip });
  }
}
