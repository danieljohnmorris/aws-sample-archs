import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as cfg from './config';
import { importBase, importServiceRole, serviceAssetDir } from './imports';

export interface RetailAppStackProps extends cdk.StackProps {
  readonly dbPassword: string;
  readonly paymentWebhookSecret: string;
}

/**
 * Retail's API and its result consumer. No WAF and no allowlist here: in this
 * architecture retail never calls pharmacy, so there is no caller address to
 * allow. The only way in from pharmacy is a message on CheckResult.
 */
export class RetailAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RetailAppStackProps) {
    super(scope, id, props);

    const { vpc, appSg, dbPort } = importBase(this, 'retail');
    const role = importServiceRole(this, 'retail');
    const asset = serviceAssetDir('retail');

    const environment: Record<string, string> = {
      SERVICE_NAME: 'retail',
      CHECK_REQUEST_QUEUE_URL: cfg.queueUrl(cfg.QUEUE.checkRequest),
      CHECK_RESULT_QUEUE_URL: cfg.queueUrl(cfg.QUEUE.checkResult),
      DATABASE_URL: cfg.databaseUrl('retail', dbPort, props.dbPassword),
      PAYMENT_WEBHOOK_SECRET: props.paymentWebhookSecret,
    };
    // ALLOWED_CIDRS is deliberately unset. The allowlist belongs to
    // architecture A; here the queue is the boundary.

    const logGroup = logs.LogGroup.fromLogGroupName(this, 'ApiLogGroup', cfg.LOG_GROUP_NAME.retail);

    const api = new lambda.Function(this, 'ApiFunction', {
      functionName: cfg.API_FUNCTION_NAME.retail,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.handler',
      code: lambda.Code.fromAsset(asset.dir),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
      role,
      environment,
      logGroup,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    const rest = new apigateway.LambdaRestApi(this, 'RetailApi', {
      restApiName: `${cfg.PREFIX}-retail`,
      handler: api,
      proxy: true,
      deployOptions: { stageName: 'prod' },
    });

    // Retail's half of the conversation coming back. The consumer runs the
    // same asset under a different handler.
    const resultQueue = sqs.Queue.fromQueueArn(this, 'CheckResultQueue', cfg.queueArn(cfg.QUEUE.checkResult));

    const consumer = new lambda.Function(this, 'ResultConsumer', {
      functionName: `${cfg.PREFIX}-retail-result-consumer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.sqsHandler',
      code: lambda.Code.fromAsset(asset.dir),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
      role,
      environment,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    consumer.addEventSource(new eventsources.SqsEventSource(resultQueue, {
      batchSize: 1,
      enabled: true,
    }));

    new cdk.CfnOutput(this, 'RetailApiUrl', {
      key: 'RetailApiUrl',
      // CDK writes the amazonaws.com form. floci serves REST APIs on its own
      // host, so the URL that answers from the host machine is built here.
      value: `http://${rest.restApiId}.execute-api.localhost.floci.io:${cfg.FLOCI_HOST_PORT}/prod`,
    });
    new cdk.CfnOutput(this, 'RetailLogGroup', { key: 'RetailLogGroup', value: cfg.LOG_GROUP_NAME.retail });
  }
}
