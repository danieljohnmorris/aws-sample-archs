#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack.js';
import { BaseStack } from '../lib/base-stack.js';
import { ACCOUNT, REGION } from '../lib/config.js';

const app = new cdk.App({ defaultStackSynthesizer: new cdk.CliCredentialsStackSynthesizer() });
const env = { account: ACCOUNT, region: REGION };

// Base holds the database and outlives App. App is the one stack a code change replaces.
const base = new BaseStack(app, 'Base', { env });
new AppStack(app, 'App', { env, vpc: base.vpc, appSg: base.appSg, db: base.db });
