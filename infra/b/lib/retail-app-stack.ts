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
    const assetDir = serviceAssetDir('retail');

    const environment: Record<string, string> = {
      SERVICE_NAME: 'retail',
      // floci injects AWS_ENDPOINT_URL into Lambda containers. AWS_REGION is
      // reserved, so it is set below on the CfnFunction.
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
      code: lambda.Code.fromAsset(assetDir, { exclude: ['test'] }),
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
    // The generated Endpoint output is the amazonaws.com URL, which does not
    // answer on floci. RetailApiUrl below is the one that does.
    rest.node.tryRemoveChild('Endpoint');

    // Retail's half of the conversation coming back. The consumer runs the
    // same asset under a different handler.
    const resultQueue = sqs.Queue.fromQueueArn(this, 'CheckResultQueue', cfg.queueArn(cfg.QUEUE.checkResult));

    const consumer = new lambda.Function(this, 'ResultConsumer', {
      functionName: `${cfg.PREFIX}-retail-result-consumer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.sqsHandler',
      code: lambda.Code.fromAsset(assetDir, { exclude: ['test'] }),
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

    // AWS_REGION is reserved, so CDK will not accept it in a Function's
    // environment. The SDK inside the function reads it, and floci does not
    // always set it, so it goes on to the CfnFunction directly.
    for (const fn of [api, consumer]) {
      (fn.node.defaultChild as lambda.CfnFunction)
        .addPropertyOverride('Environment.Variables.AWS_REGION', cfg.REGION);
    }

    new cdk.CfnOutput(this, 'RetailApiUrl', {
      key: 'RetailApiUrl',
      // floci serves a REST API at /restapis/<id>/<stage>/_user_request_ on its
      // own port. The <id>.execute-api.localhost.floci.io form that works for
      // an HTTP API is read as a virtual-host S3 bucket here and answers
      // NoSuchBucket. Measured 2026-09-03; see infra/b/NOTES.md.
      value: `${cfg.FLOCI_HOST_ENDPOINT}/restapis/${rest.restApiId}/prod/_user_request_`,
    });
    new cdk.CfnOutput(this, 'RetailLogGroup', { key: 'RetailLogGroup', value: cfg.LOG_GROUP_NAME.retail });
  }
}
