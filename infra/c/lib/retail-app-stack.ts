import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import {
  apiHostUrl,
  databaseUrl,
  EVENT_BUS_NAME,
  PREFIX,
  RETAIL_FUNCTION_NAME,
  RETAIL_LOG_GROUP,
  RETAIL_ROLE_NAME,
  RETAIL_USER_NAME,
  STAGE_NAME,
} from './config.js';

export interface RetailAppStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly db: rds.IDatabaseInstance;
  readonly dbSecret: secretsmanager.ISecret;
  /** execute-api ARNs of the pharmacy APIs, the only thing retail may call. */
  readonly pharmacyInvokeArns: string[];
  readonly pharmacyBaseUrl: string;
  /**
   * Put the retail-svc access keys in the Lambda environment. Only needed if
   * floci turns out not to evaluate the Lambda execution role.
   */
  readonly useStaticKeys: boolean;
}

/** Where the real retail app lives once it is on main. */
const APP_DIR = path.resolve(__dirname, '../../../apps/retail');

/**
 * Retail: the only public edge in architecture C.
 *
 * The Lambda has one identity, `ftw-c-retail-lambda`, and that identity is
 * what the pharmacy API allows. There is no IP allowlist anywhere and
 * ALLOWED_CIDRS is unset, so the app's own allowlist middleware stays off.
 *
 * The WAF in front of the customer API is not an allowlist either. It is the
 * managed common rule set plus a rate limit, which is the part of A's
 * perimeter that still earns its place when callers are identified by role.
 */
export class RetailAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RetailAppStackProps) {
    super(scope, id, props);

    const usingRealApp = fs.existsSync(path.join(APP_DIR, 'src', 'lambda.mjs'));
    const code = usingRealApp
      ? lambda.Code.fromAsset(APP_DIR, { exclude: ['node_modules/.cache', '*.log'] })
      : lambda.Code.fromAsset(path.resolve(__dirname, '../lambda/retail'));
    const handler = usingRealApp ? 'src/lambda.handler' : 'index.handler';

    const webhookSecret = new secretsmanager.Secret(this, 'WebhookSecret', {
      secretName: `${PREFIX}/retail/payment-webhook`,
      description: 'HMAC secret for the simulated payment webhook',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'secret',
        passwordLength: 40,
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'RetailRole', {
      roleName: RETAIL_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Identity the pharmacy API allows',
    });

    const busArn = cdk.Arn.format(
      { service: 'events', resource: 'event-bus', resourceName: EVENT_BUS_NAME },
      this,
    );
    // The whole of C's access control, written out. Nothing here names an address.
    const policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'CallPharmacy',
          actions: ['execute-api:Invoke'],
          resources: props.pharmacyInvokeArns,
        }),
        new iam.PolicyStatement({
          sid: 'PublishOrderEvents',
          actions: ['events:PutEvents'],
          resources: [busArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReadOwnSecrets',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`${webhookSecret.secretArn}*`, `${props.dbSecret.secretArn}*`],
        }),
        new iam.PolicyStatement({
          sid: 'Logs',
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [
            cdk.Arn.format({ service: 'logs', resource: 'log-group', resourceName: '*' }, this),
          ],
        }),
      ],
    });

    new iam.Policy(this, 'RetailPolicy', {
      policyName: `${PREFIX}-retail`,
      document: policy,
      roles: [role],
    });

    // Elastic network interfaces for the private subnets.
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    // Same permissions as a long-lived user. Used only if floci does not
    // evaluate the execution role; see infra/c/NOTES.md.
    const user = new iam.User(this, 'RetailUser', { userName: RETAIL_USER_NAME });
    new iam.Policy(this, 'RetailUserPolicy', {
      policyName: `${PREFIX}-retail-svc`,
      document: policy,
      users: [user],
    });
    const accessKey = new iam.CfnAccessKey(this, 'RetailUserKey', { userName: user.userName });
    const keySecret = new secretsmanager.CfnSecret(this, 'RetailUserKeySecret', {
      name: `${PREFIX}/retail/svc-keys`,
      description: 'Access keys for the retail-svc fallback identity',
      secretString: cdk.Stack.of(this).toJsonString({
        accessKeyId: accessKey.ref,
        secretAccessKey: accessKey.attrSecretAccessKey,
      }),
    });
    keySecret.node.addDependency(accessKey);

    const logGroup = new logs.LogGroup(this, 'RetailFunctionLogGroup', {
      logGroupName: RETAIL_LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = {
      SERVICE_NAME: 'retail',
      PHARMACY_BASE_URL: props.pharmacyBaseUrl,
      SIGN_REQUESTS: 'true',
      EVENT_BUS_NAME,
      DATABASE_URL: databaseUrl(
        'retail',
        props.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
        props.db.dbInstanceEndpointPort,
        'retail',
      ),
      PAYMENT_WEBHOOK_SECRET: webhookSecret.secretValueFromJson('secret').unsafeUnwrap(),
      // ALLOWED_CIDRS is deliberately absent.
    };
    if (props.useStaticKeys) {
      environment.AWS_ACCESS_KEY_ID = accessKey.ref;
      environment.AWS_SECRET_ACCESS_KEY = accessKey.attrSecretAccessKey;
    }

    const fn = new lambda.Function(this, 'RetailFunction', {
      functionName: RETAIL_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler,
      code,
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.appSg],
      logGroup,
      environment,
    });

    const api = new apigateway.LambdaRestApi(this, 'RetailApi', {
      restApiName: `${PREFIX}-retail`,
      description: 'Customer-facing retail API',
      handler: fn,
      proxy: true,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: STAGE_NAME },
    });

    const webAcl = new wafv2.CfnWebACL(this, 'RetailWebAcl', {
      name: `${PREFIX}-retail`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${PREFIX}-retail`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'CommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'RetailWebAclAssociation', {
      webAclArn: webAcl.attrArn,
      resourceArn: cdk.Arn.format(
        {
          service: 'apigateway',
          account: '',
          resource: `/restapis/${api.restApiId}/stages/${STAGE_NAME}`,
        },
        this,
      ),
    });

    new cdk.CfnOutput(this, 'RetailApiUrl', { value: apiHostUrl(api.restApiId) });
    new cdk.CfnOutput(this, 'RetailLogGroup', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'RetailRoleArn', { value: role.roleArn });
  }
}
