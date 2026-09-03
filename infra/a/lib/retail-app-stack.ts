import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  PREFIX,
  RETAIL_FUNCTION_NAME,
  RETAIL_LOG_GROUP_NAME,
  databaseName,
  ssmPath,
} from './naming';
import {
  IpAllowlist,
  containerDatabaseUrl,
  flociRestApiUrl,
  secretJsonField,
} from './perimeter';
import { readBase, readPeerNatEip, readPharmacyApiUrl } from './ssm-refs';

export interface RetailAppStackProps extends cdk.StackProps {
  /** Directory handed to lambda.Code.fromAsset. */
  readonly codePath: string;
  /** Lambda handler, `index.handler` for the placeholder. */
  readonly handler: string;
  /** floci's edge port, 4566 for architecture A. */
  readonly flociPort: string;
  /**
   * Fixed HMAC key for POST /webhooks/payment. Set locally so the end-to-end
   * test can sign a request; left undefined on AWS so the value is generated
   * and never written down.
   */
  readonly webhookSecretValue?: string;
  /** See IpAllowlistProps.useSdkShim. */
  readonly useWafSdkShim: boolean;
  /**
   * Fixed database password, matching the one RetailBase gave the instance.
   * Undefined on AWS, where the reference below resolves instead.
   */
  readonly dbPasswordValue?: string;
}

/**
 * Retail on Lambda, behind a REST API.
 *
 * Three allowlists sit in front of the handler and only the last one bites
 * under floci: a Web ACL on the stage, an API Gateway resource policy keyed on
 * aws:SourceIp, and ALLOWED_CIDRS inside the application. All three name the
 * same two addresses, so the deployed configuration reads the same whichever
 * layer is doing the work.
 */
export class RetailAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RetailAppStackProps) {
    super(scope, id, props);

    const base = readBase(this, 'retail');

    // Pharmacy's address comes from PharmacyBase. Keeping the elastic IP in the
    // base stack is what lets PharmacyApp be torn down and rebuilt without
    // retail's allowlist going stale.
    const pharmacy = readPeerNatEip(this, 'pharmacy');
    const pharmacyBaseUrl = readPharmacyApiUrl(this);

    const logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroup', RETAIL_LOG_GROUP_NAME);

    // The third-party webhook secret. Retail owns it, not the base stack: it is
    // application configuration, and nothing outside this stack reads it.
    // Deliberately unnamed. Deleting a Secrets Manager secret schedules it for
    // removal rather than removing it, so a fixed name turns "destroy RetailApp,
    // deploy RetailApp" into a name collision. Tests find it through the SSM
    // parameter written at the bottom of this stack.
    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      description: 'HMAC-SHA256 key for POST /webhooks/payment',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(props.webhookSecretValue
        ? { secretStringValue: cdk.SecretValue.unsafePlainText(props.webhookSecretValue) }
        : { generateSecretString: { passwordLength: 48, excludePunctuation: true } }),
    });

    const fn = new lambda.Function(this, 'Fn', {
      functionName: RETAIL_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(props.codePath),
      handler: props.handler,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      vpc: base.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [base.appSecurityGroup],
      environment: {
        SERVICE_NAME: 'retail',
        PHARMACY_BASE_URL: pharmacyBaseUrl,
        DATABASE_URL: containerDatabaseUrl({
          port: base.dbEndpointPort,
          database: databaseName('retail'),
          username: 'postgres',
          // floci passes `{{resolve:secretsmanager:…}}` into a Lambda
          // environment variable verbatim, so pg is handed a URL it cannot
          // parse and every request fails with "Invalid URL". Measured
          // 2026-09-03, see NOTES.md. Locally the password is inlined.
          password: props.dbPasswordValue ?? secretJsonField(base.dbSecretArn, 'password'),
        }),
        // Pharmacy's NAT address, loopback because floci reports every caller
        // through API Gateway as 127.0.0.1, and the private range the shared
        // Docker network sits in.
        ALLOWED_CIDRS: `${pharmacy.cidr},127.0.0.1/32,172.16.0.0/12`,
        // Same reason as the password above.
        PAYMENT_WEBHOOK_SECRET:
          props.webhookSecretValue ?? webhookSecret.secretValue.unsafeUnwrap(),
      },
    });

    // floci creates /aws/lambda/<name> on first invoke regardless. The group is
    // declared in the base stack under that exact name so retention is set once
    // and there is only ever one group.
    logGroup.grantWrite(fn);

    const api = new apigateway.LambdaRestApi(this, 'Api', {
      restApiName: `${PREFIX}-retail`,
      description: 'Retail edge. Proxy to the retail Lambda.',
      handler: fn,
      proxy: true,
      // Skips the account-wide API Gateway CloudWatch role, which is one shared
      // resource three architectures would otherwise fight over.
      cloudWatchRole: false,
      deployOptions: { stageName: 'prod' },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              // A resource policy that only allows makes everything else a deny.
              // On AWS this is what stops a caller outside the two addresses.
              // floci returns 200 to any address; see NOTES.md.
              IpAddress: { 'aws:SourceIp': [pharmacy.cidr, '127.0.0.1/32'] },
            },
          }),
        ],
      }),
    });

    // RestApi emits an `Endpoint` output holding an execute-api.amazonaws.com
    // URL that floci does not serve. Removed so outputs.json carries one URL and
    // it is the one that answers.
    api.node.tryRemoveChild('Endpoint');

    const stageArn = `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`;

    const perimeter = new IpAllowlist(this, 'Perimeter', {
      name: `${PREFIX}-retail`,
      allowedCidrs: [pharmacy.cidr, '127.0.0.1/32'],
      resourceArn: stageArn,
      useSdkShim: props.useWafSdkShim,
    });

    const apiUrl = flociRestApiUrl(
      api.restApiId,
      api.deploymentStage.stageName,
      props.flociPort,
    );

    new ssm.StringParameter(this, 'ParamApiUrl', {
      parameterName: ssmPath('retail', 'api-url'),
      stringValue: apiUrl,
      description: 'Retail REST API base URL',
    });
    new ssm.StringParameter(this, 'ParamWebhookSecretArn', {
      parameterName: ssmPath('retail', 'payment-webhook-secret-arn'),
      stringValue: webhookSecret.secretArn,
      description: 'Secret the payment webhook signature is checked against',
    });

    new cdk.CfnOutput(this, 'RetailApiUrl', { value: apiUrl });
    new cdk.CfnOutput(this, 'RetailLogGroup', { value: RETAIL_LOG_GROUP_NAME });
    new cdk.CfnOutput(this, 'RetailWebAclArn', { value: perimeter.webAclArn });
    new cdk.CfnOutput(this, 'RetailIpSetArn', { value: perimeter.ipSetArn });
    new cdk.CfnOutput(this, 'RetailNatEip', { value: base.natEip });
    new cdk.CfnOutput(this, 'RetailDbSgId', { value: base.dbSecurityGroupId });
    new cdk.CfnOutput(this, 'RetailAppSgId', { value: base.appSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, 'RetailVpcId', { value: base.vpcId });
  }
}
