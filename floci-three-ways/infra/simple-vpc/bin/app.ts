#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, REGION } from '../lib/config.js';
import { PharmacyAppStack } from '../lib/pharmacy-app-stack.js';
import { RetailAppStack } from '../lib/retail-app-stack.js';
import { SharedBaseStack } from '../lib/shared-base-stack.js';

// Same synthesizer as A, B and C, so asset publishing never assumes a bootstrap role.
const app = new cdk.App({ defaultStackSynthesizer: new cdk.CliCredentialsStackSynthesizer() });
const env = { account: ACCOUNT, region: REGION };

const base = new SharedBaseStack(app, 'SharedBase', { env });
const pharmacy = new PharmacyAppStack(app, 'PharmacyApp', {
  env,
  vpc: base.vpc,
  appSg: base.pharmacyAppSg,
  albSg: base.pharmacyAlbSg,
  db: base.pharmacyDb,
});
new RetailAppStack(app, 'RetailApp', {
  env,
  vpc: base.vpc,
  appSg: base.retailAppSg,
  db: base.retailDb,
  pharmacyBaseUrl: pharmacy.internalBaseUrl,
});
