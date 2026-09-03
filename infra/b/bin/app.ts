#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BaseStack } from '../lib/base-stack';
import * as cfg from '../lib/config';
import { MessagingStack } from '../lib/messaging-stack';
import { PharmacyAppStack } from '../lib/pharmacy-app-stack';
import { RetailAppStack } from '../lib/retail-app-stack';

function main(): void {
  // CDK's default synthesiser assumes the bootstrapped file-publishing and
  // deployment roles. Under floci's IAM enforcement those roles are denied
  // everything, because CloudFormation stores their inline policies with the
  // Fn::Sub in Resource unresolved, so the filter never matches an ARN. The
  // CLI credentials synthesiser publishes and deploys with the caller's own
  // key instead. See infra/b/NOTES.md.
  const app = new cdk.App({
    defaultStackSynthesizer: new cdk.CliCredentialsStackSynthesizer(),
  });
  const env = { account: cfg.ACCOUNT, region: cfg.REGION };

  const retailDbPassword = cfg.requiredEnv('RETAIL_DB_PASSWORD');
  const pharmacyDbPassword = cfg.requiredEnv('PHARMACY_DB_PASSWORD');
  const paymentWebhookSecret = cfg.requiredEnv('PAYMENT_WEBHOOK_SECRET');

  const retailBase = new BaseStack(app, 'RetailBase', {
    env,
    service: 'retail',
    vpcOutputKey: 'RetailVpcId',
    dbPassword: retailDbPassword,
    terminationProtection: true,
    description: 'Retail VPC, endpoints, Postgres and log group',
  });

  const pharmacyBase = new BaseStack(app, 'PharmacyBase', {
    env,
    service: 'pharmacy',
    vpcOutputKey: 'PharmacyVpcId',
    dbPassword: pharmacyDbPassword,
    terminationProtection: true,
    description: 'Pharmacy VPC, endpoints, Postgres and log group',
  });

  const messaging = new MessagingStack(app, 'Messaging', {
    env,
    description: 'Queues, keys, service users and roles, outside both VPCs',
  });

  // The app stacks read the base and messaging ids through
  // AWS::SSM::Parameter::Value<String> parameters, so they synthesise without
  // anything being deployed first. The dependencies below are what put the
  // stacks in the right order; nothing here becomes a CloudFormation export.
  const retailApp = new RetailAppStack(app, 'RetailApp', {
    env,
    dbPassword: retailDbPassword,
    paymentWebhookSecret,
    description: 'Retail API Lambda, REST API and CheckResult consumer',
  });
  retailApp.addDependency(retailBase);
  retailApp.addDependency(messaging);

  const pharmacyApp = new PharmacyAppStack(app, 'PharmacyApp', {
    env,
    dbPassword: pharmacyDbPassword,
    workerImage: process.env.PHARMACY_IMAGE ?? 'ftw-pharmacy:local',
    description: 'Pharmacy queue worker on Fargate and a seeding HTTP API',
  });
  pharmacyApp.addDependency(pharmacyBase);
  pharmacyApp.addDependency(messaging);

  app.synth();
}

main();
