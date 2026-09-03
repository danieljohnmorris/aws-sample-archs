import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as cfg from './config';
import { importBase, importServiceRole, serviceAssetDir } from './imports';
import { ssmString } from './ssm-param';

export interface PharmacyAppStackProps extends cdk.StackProps {
  readonly dbPassword: string;
  /** Image tag built by `make images ARCH=b`. */
  readonly workerImage: string;
}

/**
 * Pharmacy has no load balancer and no inbound listener for the check path.
 * The worker task pulls from CheckRequest and answers on CheckResult, so
 * nothing outside the pharmacy VPC can address it.
 *
 * The HTTP API next to it exists only so tests can seed a prescription and
 * read health. It is not how retail talks to pharmacy.
 */
export class PharmacyAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PharmacyAppStackProps) {
    super(scope, id, props);

    const { vpc, appSg, dbPort } = importBase(this, 'pharmacy');
    const role = importServiceRole(this, 'pharmacy');
    const asset = serviceAssetDir('pharmacy');

    const queueEnv = {
      SERVICE_NAME: 'pharmacy',
      CHECK_REQUEST_QUEUE_URL: cfg.queueUrl(cfg.QUEUE.checkRequest),
      CHECK_RESULT_QUEUE_URL: cfg.queueUrl(cfg.QUEUE.checkResult),
      DATABASE_URL: cfg.databaseUrl('pharmacy', dbPort, props.dbPassword),
    };

    const seedLogGroup = logs.LogGroup.fromLogGroupName(this, 'ApiLogGroup', cfg.LOG_GROUP_NAME.pharmacy);

    const seed = new lambda.Function(this, 'ApiFunction', {
      functionName: cfg.API_FUNCTION_NAME.pharmacy,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.handler',
      code: lambda.Code.fromAsset(asset.dir),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
      role,
      environment: { ...queueEnv },
      logGroup: seedLogGroup,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    // Explicit pharmacy-svc keys. floci's handling of the Lambda execution
    // role under IAM enforcement is not established, and these keys make the
    // denial visible either way. CDK refuses to set AWS_ACCESS_KEY_ID through
    // the Function environment because the real Lambda runtime reserves it, so
    // they go on to the CfnFunction directly. AWS_SESSION_TOKEN is blanked so
    // a token floci injects for the execution role cannot be paired with these
    // keys and fail the signature.
    const cfnSeed = seed.node.defaultChild as lambda.CfnFunction;
    cfnSeed.addPropertyOverride(
      'Environment.Variables.AWS_ACCESS_KEY_ID',
      ssmString(this, 'PharmacyAccessKeyIdParam', cfg.SVC_KEY_PARAM.accessKeyId),
    );
    cfnSeed.addPropertyOverride(
      'Environment.Variables.AWS_SECRET_ACCESS_KEY',
      ssmString(this, 'PharmacySecretAccessKeyParam', cfg.SVC_KEY_PARAM.secretAccessKey),
    );
    cfnSeed.addPropertyOverride('Environment.Variables.AWS_SESSION_TOKEN', '');

    const httpApi = new apigwv2.HttpApi(this, 'PharmacyApi', { apiName: `${cfg.PREFIX}-pharmacy` });
    const integration = new integrations.HttpLambdaIntegration('SeedIntegration', seed);
    httpApi.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/prescriptions', methods: [apigwv2.HttpMethod.POST], integration });

    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: `/${cfg.PREFIX}/pharmacy-worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${cfg.PREFIX}-pharmacy-exec`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${cfg.REGION}:${cfg.ACCOUNT}:secret:${cfg.PREFIX}/*`],
    }));

    const svcSecret = secretsmanager.Secret.fromSecretNameV2(this, 'PharmacySvcSecret', cfg.SVC_SECRET_NAME.pharmacy);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      family: `${cfg.PREFIX}-pharmacy-worker`,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: role,
      executionRole,
    });

    taskDefinition.addContainer('worker', {
      containerName: 'worker',
      image: ecs.ContainerImage.fromRegistry(props.workerImage),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: workerLogGroup }),
      environment: {
        ...queueEnv,
        PORT: '8080',
        AWS_ENDPOINT_URL: cfg.FLOCI_INTERNAL_ENDPOINT,
        AWS_REGION: cfg.REGION,
        AWS_DEFAULT_REGION: cfg.REGION,
      },
      secrets: {
        AWS_ACCESS_KEY_ID: ecs.Secret.fromSecretsManager(svcSecret, 'accessKeyId'),
        AWS_SECRET_ACCESS_KEY: ecs.Secret.fromSecretsManager(svcSecret, 'secretAccessKey'),
      },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: `${cfg.PREFIX}-pharmacy` });

    new ecs.FargateService(this, 'WorkerService', {
      serviceName: `${cfg.PREFIX}-pharmacy-worker`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
    });

    new cdk.CfnOutput(this, 'PharmacyApiUrl', {
      key: 'PharmacyApiUrl',
      value: `http://${httpApi.apiId}.execute-api.localhost.floci.io:${cfg.FLOCI_HOST_PORT}`,
    });
  }
}
