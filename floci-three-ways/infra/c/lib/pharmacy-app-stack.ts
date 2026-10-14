import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpUrlIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import {
  ALB_LISTENER_PORT,
  albUpstream,
  apiHostUrl,
  apiInternalUrl,
  databasePassword,
  databaseUrl,
  FLOCI_HOSTNAME,
  FLOCI_INTERNAL_PORT,
  PHARMACY_CONTAINER_PORT,
  PHARMACY_HEALTH_PATH,
  PHARMACY_IMAGE,
  PREFIX,
  RETAIL_ROLE_NAME,
  STAGE_NAME,
} from './config.js';

export interface PharmacyAppStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly albSg: ec2.ISecurityGroup;
  readonly db: rds.IDatabaseInstance;
  readonly dbSecret: secretsmanager.ISecret;
}

/**
 * Pharmacy: Fargate behind an internal ALB, fronted by a REST API that only
 * the retail role may call.
 *
 * There is no public route to this service. Every method is AWS_IAM and the
 * resource policy names one principal, the retail Lambda role. The ARN is
 * built from a fixed role name so this stack does not import from RetailApp,
 * which lets RetailApp depend on this one instead of the two forming a cycle.
 */
export class PharmacyAppStack extends cdk.Stack {
  readonly api: apigateway.RestApi;
  /** Base URL for callers inside the ftw-c network. */
  readonly internalBaseUrl: string;
  /** execute-api ARNs the retail role is allowed to invoke. */
  readonly invokeArns: string[];

  constructor(scope: Construct, id: string, props: PharmacyAppStackProps) {
    super(scope, id, props);

    const retailRoleArn = cdk.Arn.format({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: RETAIL_ROLE_NAME,
    }, this);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${PREFIX}-pharmacy`,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${PREFIX}-pharmacy`,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // No log configuration: floci does not ship container stdout to CloudWatch,
    // and the awslogs driver would only add a failure mode.
    taskDefinition.addContainer('pharmacy', {
      containerName: 'pharmacy',
      image: ecs.ContainerImage.fromRegistry(PHARMACY_IMAGE),
      portMappings: [{ containerPort: PHARMACY_CONTAINER_PORT, protocol: ecs.Protocol.TCP }],
      environment: {
        SERVICE_NAME: 'pharmacy',
        PORT: String(PHARMACY_CONTAINER_PORT),
        // ALLOWED_CIDRS is deliberately absent. C identifies callers by role.
        AWS_ENDPOINT_URL: `http://${FLOCI_HOSTNAME}:${FLOCI_INTERNAL_PORT}`,
        // Both spellings: the SDK v3 environment provider reads AWS_REGION,
        // and SigV4 signing throws without one.
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        DATABASE_URL: databaseUrl(
          'pharmacy',
          databasePassword(),
          props.db.dbInstanceEndpointPort,
          'pharmacy',
        ),
      },
    });

    props.dbSecret.grantRead(taskDefinition.taskRole);

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: `${PREFIX}-pharmacy`,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      securityGroups: [props.appSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: false },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${PREFIX}-pharmacy-alb`,
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const listener = alb.addListener('Listener', {
      port: ALB_LISTENER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets('Pharmacy', {
      port: PHARMACY_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: PHARMACY_HEALTH_PATH,
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    // floci's embedded DNS answers <name>.elb.floci with floci's own address,
    // and Cloud Map private DNS does not resolve at all, so the ALB DNS name is
    // the only working way to address the service.
    const albBase = `http://${alb.loadBalancerDnsName}:${ALB_LISTENER_PORT}`;

    // One Allow for one principal. Anything else is an implicit deny.
    const resourcePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ArnPrincipal(retailRoleArn)],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
        }),
      ],
    });

    this.api = new apigateway.RestApi(this, 'PharmacyApi', {
      restApiName: `${PREFIX}-pharmacy`,
      description: 'Pharmacy, callable only by the retail role',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: STAGE_NAME },
      policy: resourcePolicy,
      // apiKeyRequired is set rather than left to default, because floci only
      // reports the fields the template carried and a reader cannot tell an
      // absent field from a false one.
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.IAM,
        apiKeyRequired: false,
      },
    });

    const health = this.api.root.addResource('health');
    health.addMethod('GET', this.proxyTo(`${albBase}/health`, 'GET'), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: false,
    });

    const prescriptions = this.api.root.addResource('prescriptions');
    prescriptions.addMethod('POST', this.proxyTo(`${albBase}/prescriptions`, 'POST'), {
      authorizationType: apigateway.AuthorizationType.IAM,
      apiKeyRequired: false,
    });

    const prescription = prescriptions.addResource('{id}');
    const check = prescription.addResource('check');
    check.addMethod(
      'GET',
      this.proxyTo(`${albBase}/prescriptions/{id}/check`, 'GET', {
        'integration.request.path.id': 'method.request.path.id',
        'integration.request.querystring.customerId': 'method.request.querystring.customerId',
        'integration.request.querystring.sku': 'method.request.querystring.sku',
      }),
      {
        authorizationType: apigateway.AuthorizationType.IAM,
        apiKeyRequired: false,
        requestParameters: {
          'method.request.path.id': true,
          'method.request.querystring.customerId': false,
          'method.request.querystring.sku': false,
        },
      },
    );

    // floci's REST implementation answers `Unsupported integration type:
    // HTTP_PROXY` (and the same for HTTP), so nothing reaches pharmacy through
    // the API above. Its HTTP API implementation does run HTTP_PROXY. This
    // second API carries the traffic on floci and would not exist on AWS.
    // Same three routes, same AWS_IAM authorisation. See infra/c/NOTES.md.
    const iam4 = new HttpIamAuthorizer();
    const httpApi = new apigatewayv2.HttpApi(this, 'PharmacyHttpApi', {
      apiName: `${PREFIX}-pharmacy-http`,
      description: 'floci traffic path for the pharmacy REST API',
      createDefaultStage: false,
      defaultAuthorizer: iam4,
    });
    new apigatewayv2.HttpStage(this, 'PharmacyHttpStage', {
      httpApi,
      stageName: STAGE_NAME,
      autoDeploy: true,
    });

    const upstream = albUpstream();
    for (const [routeId, methods, routePath, upstreamPath] of [
      ['Health', [apigatewayv2.HttpMethod.GET], '/health', '/health'],
      ['SeedPrescription', [apigatewayv2.HttpMethod.POST], '/prescriptions', '/prescriptions'],
      [
        'CheckPrescription',
        [apigatewayv2.HttpMethod.GET],
        '/prescriptions/{id}/check',
        '/prescriptions/{id}/check',
      ],
    ] as const) {
      httpApi.addRoutes({
        path: routePath,
        methods: [...methods],
        integration: new HttpUrlIntegration(routeId, `${upstream}${upstreamPath}`, {
          method: methods[0],
        }),
        authorizer: iam4,
      });
    }

    this.internalBaseUrl = apiInternalUrl(httpApi.apiId);
    this.invokeArns = [
      this.api.arnForExecuteApi(),
      cdk.Arn.format({ service: 'execute-api', resource: httpApi.apiId, resourceName: '*' }, this),
    ];

    new cdk.CfnOutput(this, 'PharmacyApiUrl', { value: apiHostUrl(httpApi.apiId) });
    new cdk.CfnOutput(this, 'PharmacyRestApiId', { value: this.api.restApiId });
    new cdk.CfnOutput(this, 'PharmacyCheckResourceId', { value: check.resourceId });
    new cdk.CfnOutput(this, 'PharmacyAlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'PharmacyInternalBaseUrl', { value: this.internalBaseUrl });
    new cdk.CfnOutput(this, 'PharmacyRestApiUrl', { value: apiHostUrl(this.api.restApiId) });
  }

  private proxyTo(
    uri: string,
    httpMethod: string,
    requestParameters?: Record<string, string>,
  ): apigateway.Integration {
    return new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: httpMethod,
      uri,
      options: {
        connectionType: apigateway.ConnectionType.INTERNET,
        ...(requestParameters ? { requestParameters } : {}),
      },
    });
  }
}
