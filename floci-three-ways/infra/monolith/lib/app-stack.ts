import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import {
  apiHostUrl,
  APP_DIR,
  assertAppReady,
  databasePassword,
  databaseUrl,
  DB_NAME,
  FUNCTION_NAME,
  LOG_GROUP,
  paymentWebhookSecret,
  PREFIX,
  STAGE_NAME,
} from './config.js';
import { customerWebAcl } from './edge.js';

export interface AppStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly db: rds.IDatabaseInstance;
}

/** One Lambda behind one REST API with the same customer edge as the others. */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    assertAppReady();

    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      logGroupName: LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      functionName: FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.handler',
      code: lambda.Code.fromAsset(APP_DIR, { exclude: ['test', '*.log'] }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.appSg],
      logGroup,
      environment: {
        SERVICE_NAME: 'monolith',
        DATABASE_URL: databaseUrl(DB_NAME, databasePassword(), props.db.dbInstanceEndpointPort, DB_NAME),
        PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret(),
      },
    });

    const api = new apigateway.LambdaRestApi(this, 'Api', {
      restApiName: `${PREFIX}-shop`,
      description: 'The one public API: retail and pharmacy routes',
      handler: fn,
      proxy: true,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: STAGE_NAME },
    });
    customerWebAcl(this, `${PREFIX}-shop`, api.restApiId, STAGE_NAME);

    const url = apiHostUrl(api.restApiId);
    // The e2e scenario reads two keys. Both are the one URL here.
    new cdk.CfnOutput(this, 'RetailApiUrl', { value: url });
    new cdk.CfnOutput(this, 'PharmacyApiUrl', { value: url });
    new cdk.CfnOutput(this, 'RetailLogGroup', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'AppVpcId', { value: props.vpc.vpcId });
  }
}
