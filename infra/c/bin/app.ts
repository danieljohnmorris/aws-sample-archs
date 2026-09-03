#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, REGION } from '../lib/config.js';
import { EventsStack } from '../lib/events-stack.js';
import { PharmacyAppStack } from '../lib/pharmacy-app-stack.js';
import { RetailAppStack } from '../lib/retail-app-stack.js';
import { SharedBaseStack } from '../lib/shared-base-stack.js';

// floci's IAM enforcement resolves s3:ListBucket to
// `arn:aws:s3:::<bucket>/`, with a trailing slash, so the bootstrap
// file-publishing role's policy never matches and asset upload fails with
// "exists, but we dont have access to it". CliCredentialsStackSynthesizer
// skips the role assumption and publishes with the CLI credentials, which are
// the `test` key and bypass enforcement. See infra/c/NOTES.md.
const app = new cdk.App({
  defaultStackSynthesizer: new cdk.CliCredentialsStackSynthesizer(),
});
const env = { account: ACCOUNT, region: REGION };

// SharedBase and Events hold state. PharmacyApp and RetailApp are the two
// stacks that get destroyed and redeployed while the rest stays put.
const base = new SharedBaseStack(app, 'SharedBase', { env });
new EventsStack(app, 'Events', { env });

const pharmacy = new PharmacyAppStack(app, 'PharmacyApp', {
  env,
  vpc: base.vpc,
  appSg: base.pharmacyAppSg,
  albSg: base.pharmacyAlbSg,
  db: base.pharmacyDb,
  dbSecret: base.pharmacyDbSecret,
});

new RetailAppStack(app, 'RetailApp', {
  env,
  vpc: base.vpc,
  appSg: base.retailAppSg,
  db: base.retailDb,
  dbSecret: base.retailDbSecret,
  pharmacyInvokeArns: pharmacy.invokeArns,
  pharmacyBaseUrl: pharmacy.internalBaseUrl,
  useStaticKeys: app.node.tryGetContext('useStaticKeys') === 'true',
  forceRegionEnv: app.node.tryGetContext('forceRegionEnv') === 'true',
});
