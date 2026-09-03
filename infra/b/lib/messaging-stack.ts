import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as cfg from './config';

/**
 * SQS is regional, so the queues sit outside both VPCs. Retail and pharmacy
 * reach them through the SQS interface endpoint in their own VPC.
 *
 * Two layers of policy are declared here. Queue policies name the two role
 * ARNs and are what a reviewer would read. floci does not enforce them (see
 * the "Does not enforce" table in docs/day-one-floci-checks.md), so the
 * identity policies on the two service users are the ones that can be seen
 * denying anything.
 */
export class MessagingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const key = new kms.Key(this, 'MessagingKey', {
      alias: cfg.KMS_ALIAS,
      description: 'ftw-b queue encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const makeQueue = (idPrefix: string, name: string, dlqName: string) => {
      const dlq = new sqs.Queue(this, `${idPrefix}Dlq`, {
        queueName: dlqName,
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: key,
        retentionPeriod: cdk.Duration.days(14),
      });
      const queue = new sqs.Queue(this, idPrefix, {
        queueName: name,
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: key,
        visibilityTimeout: cdk.Duration.seconds(30),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });
      return { queue, dlq };
    };

    const request = makeQueue('CheckRequestQueue', cfg.QUEUE.checkRequest, cfg.QUEUE.checkRequestDlq);
    const result = makeQueue('CheckResultQueue', cfg.QUEUE.checkResult, cfg.QUEUE.checkResultDlq);

    const retailRoleArn = cfg.roleArn('retail');
    const pharmacyRoleArn = cfg.roleArn('pharmacy');

    // A Lambda that puts a queue policy on a queue with SetQueueAttributes.
    // floci reports AWS::SQS::QueuePolicy as CREATE_COMPLETE and then serves
    // the queue with no Policy attribute, so the declared policy is not
    // readable. Both are created below: the CloudFormation resource is what
    // works on AWS, this is what makes it observable here.
    const policyApplierRole = new iam.Role(this, 'QueuePolicyApplierRole', {
      roleName: `${cfg.PREFIX}-queue-policy-applier`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    policyApplierRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SetQueueAttributes', 'sqs:GetQueueAttributes'],
      resources: [cfg.SQS_RESOURCE_UNDER_FLOCI],
    }));
    policyApplierRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${cfg.REGION}:${cfg.ACCOUNT}:*`],
    }));

    const policyApplier = new lambda.Function(this, 'QueuePolicyApplier', {
      functionName: `${cfg.PREFIX}-queue-policy-applier`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '..', 'custom-resources', 'queue-policy')),
      role: policyApplierRole,
      timeout: cdk.Duration.seconds(30),
    });

    const applyPolicy = (id: string, queue: sqs.Queue, statements: iam.PolicyStatement[]) => {
      const queuePolicy = new sqs.QueuePolicy(this, id, { queues: [queue] });
      queuePolicy.document.addStatements(...statements);
      new cdk.CustomResource(this, `${id}Apply`, {
        serviceToken: policyApplier.functionArn,
        properties: {
          QueueUrl: queue.queueUrl,
          Policy: cdk.Stack.of(this).toJsonString(queuePolicy.document.toJSON()),
        },
      });
    };

    // CheckRequest: retail writes, pharmacy reads. CheckResult is the mirror.
    applyPolicy('CheckRequestQueuePolicy', request.queue, [
      new iam.PolicyStatement({
        sid: 'RetailSends',
        principals: [new iam.ArnPrincipal(retailRoleArn)],
        actions: ['sqs:SendMessage'],
        resources: [request.queue.queueArn],
      }),
      new iam.PolicyStatement({
        sid: 'PharmacyConsumes',
        principals: [new iam.ArnPrincipal(pharmacyRoleArn)],
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'],
        resources: [request.queue.queueArn],
      }),
    ]);

    applyPolicy('CheckResultQueuePolicy', result.queue, [
      new iam.PolicyStatement({
        sid: 'PharmacySends',
        principals: [new iam.ArnPrincipal(pharmacyRoleArn)],
        actions: ['sqs:SendMessage'],
        resources: [result.queue.queueArn],
      }),
      new iam.PolicyStatement({
        sid: 'RetailConsumes',
        principals: [new iam.ArnPrincipal(retailRoleArn)],
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'],
        resources: [result.queue.queueArn],
      }),
    ]);

    /**
     * Every SQS statement below uses arn:aws:sqs:eu-west-2:000000000000:*
     * on purpose. floci's IAM enforcement filter resolves an SQS request to
     * the wildcard queue ARN before it evaluates the policy, so a statement
     * naming one queue never matches and the call is denied. See the "IAM
     * enforcement mode" section of docs/day-one-floci-checks.md. What is left
     * is action-level: an identity holds sqs:SendMessage or it does not.
     */
    const sqsStatement = (actions: string[]) => new iam.PolicyStatement({
      actions,
      resources: [cfg.SQS_RESOURCE_UNDER_FLOCI],
    });

    // Resource is a wildcard because the key id is only known at deploy time,
    // and a Resource written as an Fn::GetAtt is stored unresolved by floci's
    // CloudFormation, which then never matches under IAM enforcement. Same
    // reason as the SQS note above; see infra/b/NOTES.md.
    const kmsStatement = () => new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: ['*'],
    });

    const SEND = ['sqs:SendMessage', 'sqs:GetQueueUrl', 'sqs:GetQueueAttributes'];
    const CONSUME = ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'];

    // Lambda and ECS assume these. The retail role also consumes, because the
    // event source mapping on CheckResult runs under the function's role.
    const retailRole = new iam.Role(this, 'RetailRole', {
      roleName: cfg.ROLE_NAME.retail,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
    });
    retailRole.addToPolicy(sqsStatement([...SEND, ...CONSUME]));
    retailRole.addToPolicy(kmsStatement());

    const pharmacyRole = new iam.Role(this, 'PharmacyRole', {
      roleName: cfg.ROLE_NAME.pharmacy,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
    });
    pharmacyRole.addToPolicy(sqsStatement([...CONSUME, ...SEND]));
    pharmacyRole.addToPolicy(kmsStatement());

    // Written out rather than attaching the AWS managed policies, so nothing
    // depends on floci carrying service-role/AWSLambdaVPCAccessExecutionRole.
    for (const role of [retailRole, pharmacyRole]) {
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${cfg.REGION}:${cfg.ACCOUNT}:*`],
      }));
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'],
      }));
      role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${cfg.REGION}:${cfg.ACCOUNT}:secret:${cfg.PREFIX}/*`],
      }));
    }

    // The two service users. Their keys are what the verification commands in
    // NOTES.md use, because the test/test key bypasses IAM enforcement.
    const makeUser = (idPrefix: string, userName: string, secretName: string, actions: string[]) => {
      const user = new iam.User(this, idPrefix, { userName });
      user.addToPolicy(sqsStatement(actions));
      user.addToPolicy(kmsStatement());
      const accessKey = new iam.CfnAccessKey(this, `${idPrefix}AccessKey`, { userName: user.userName });
      new secretsmanager.CfnSecret(this, `${idPrefix}Secret`, {
        name: secretName,
        description: `${userName} access key`,
        secretString: cdk.Stack.of(this).toJsonString({
          accessKeyId: accessKey.ref,
          secretAccessKey: accessKey.attrSecretAccessKey,
        }),
      });
      return accessKey;
    };

    // retail-svc sends and nothing else. Retail's inbound path is the event
    // source mapping on CheckResult, which floci polls itself, so this user
    // has no need of sqs:ReceiveMessage. Granting it would, under action-level
    // enforcement, grant receive on every queue.
    makeUser('RetailSvcUser', cfg.USER_NAME.retail, cfg.SVC_SECRET_NAME.retail, SEND);

    // pharmacy-svc consumes CheckRequest and replies on CheckResult, so it
    // needs both halves. The container and the seeding Lambda use these keys.
    const pharmacyKey = makeUser(
      'PharmacySvcUser',
      cfg.USER_NAME.pharmacy,
      cfg.SVC_SECRET_NAME.pharmacy,
      [...CONSUME, ...SEND],
    );

    // The secret above is the copy a person would read. These two parameters
    // exist because a Lambda cannot be handed a Secrets Manager value: it has
    // no equivalent of the ECS task definition's Secrets field, and floci
    // leaves {{resolve:secretsmanager:...}} in a Lambda environment variable
    // unresolved. An SSM parameter is the one deploy-time channel floci does
    // resolve. Local emulator, throwaway account.
    new ssm.StringParameter(this, 'PharmacySvcAccessKeyIdParam', {
      parameterName: cfg.SVC_KEY_PARAM.accessKeyId,
      stringValue: pharmacyKey.ref,
    });
    new ssm.StringParameter(this, 'PharmacySvcSecretAccessKeyParam', {
      parameterName: cfg.SVC_KEY_PARAM.secretAccessKey,
      stringValue: pharmacyKey.attrSecretAccessKey,
    });

    new cdk.CfnOutput(this, 'CheckRequestQueueUrl', { key: 'CheckRequestQueueUrl', value: request.queue.queueUrl });
    new cdk.CfnOutput(this, 'CheckResultQueueUrl', { key: 'CheckResultQueueUrl', value: result.queue.queueUrl });
    new cdk.CfnOutput(this, 'CheckRequestDlqUrl', { key: 'CheckRequestDlqUrl', value: request.dlq.queueUrl });
    new cdk.CfnOutput(this, 'CheckResultDlqUrl', { key: 'CheckResultDlqUrl', value: result.dlq.queueUrl });
    new cdk.CfnOutput(this, 'RetailRoleArn', { key: 'RetailRoleArn', value: retailRole.roleArn });
    new cdk.CfnOutput(this, 'PharmacyRoleArn', { key: 'PharmacyRoleArn', value: pharmacyRole.roleArn });
  }
}
