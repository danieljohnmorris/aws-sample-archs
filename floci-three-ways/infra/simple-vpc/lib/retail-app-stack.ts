import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import {
  apiHostUrl,
  assertRetailAppReady,
  databasePassword,
  databaseUrl,
  paymentWebhookSecret,
  PREFIX,
  RETAIL_APP_DIR,
  RETAIL_FUNCTION_NAME,
  RETAIL_LOG_GROUP,
  STAGE_NAME,
} from './config.js';
import { customerWebAcl } from './edge.js';

export interface RetailAppStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly db: rds.IDatabaseInstance;
  readonly pharmacyBaseUrl: string;
}

/**
 * Retail: Lambda in the private subnets behind the customer REST API. It
 * calls pharmacy with a plain GET. PHARMACY_BASE_URL is the only wiring:
 * no SIGN_REQUESTS, no ALLOWED_CIDRS, no queue, no bus.
 */
export class RetailAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RetailAppStackProps) {
    super(scope, id, props);
    assertRetailAppReady();

    const logGroup = new logs.LogGroup(this, 'RetailFunctionLogGroup', {
      logGroupName: RETAIL_LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'RetailFunction', {
      functionName: RETAIL_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/lambda.handler',
      code: lambda.Code.fromAsset(RETAIL_APP_DIR, { exclude: ['test', '*.log'] }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.appSg],
      logGroup,
      environment: {
        SERVICE_NAME: 'retail',
        PHARMACY_BASE_URL: props.pharmacyBaseUrl,
        DATABASE_URL: databaseUrl('retail', databasePassword(), props.db.dbInstanceEndpointPort, 'retail'),
        PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret(),
      },
    });

    const api = new apigateway.LambdaRestApi(this, 'RetailApi', {
      restApiName: `${PREFIX}-retail`,
      description: 'Customer-facing retail API',
      handler: fn,
      proxy: true,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: STAGE_NAME },
    });
    customerWebAcl(this, `${PREFIX}-retail`, api.restApiId, STAGE_NAME);

    new cdk.CfnOutput(this, 'RetailApiUrl', { value: apiHostUrl(api.restApiId) });
    new cdk.CfnOutput(this, 'RetailLogGroup', { value: logGroup.logGroupName });
    // Repeated from SharedBase so a partial redeploy keeps outputs.json whole.
    new cdk.CfnOutput(this, 'VpcId', { value: props.vpc.vpcId });
  }
}
