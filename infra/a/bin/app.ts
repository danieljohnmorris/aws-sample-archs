#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { BaseStack } from '../lib/base-stack';
import { PharmacyAppStack } from '../lib/pharmacy-app-stack';
import { RetailAppStack } from '../lib/retail-app-stack';

/**
 * Architecture A: perimeter and addresses.
 *
 * Four stacks. RetailBase and PharmacyBase hold the network, the database and
 * the public address each side leaves from. RetailApp and PharmacyApp hold the
 * things that get replaced. Everything crosses between them through SSM, never
 * a CloudFormation export, so a base stack stays editable while the app stacks
 * are up and an app stack can be destroyed without the base noticing.
 */

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000',
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
};

const flociPort = process.env.FLOCI_PORT ?? '4566';
/** Inside the 8080-8089 range docker-compose publishes for architecture A. */
const albPort = Number(process.env.ALB_LISTENER_PORT ?? 8080);

const repoRoot = path.resolve(__dirname, '../../..');

// The applications are built against CONTRACT.md and land on main separately.
// Until they do, retail runs a handler written here and pharmacy runs nginx, so
// the perimeter can be deployed and checked without them.
const retailAppDir = path.join(repoRoot, 'apps', 'retail');
const retailAppPresent = fs.existsSync(path.join(retailAppDir, 'src', 'lambda.mjs'));
const pharmacyAppPresent = fs.existsSync(path.join(repoRoot, 'apps', 'pharmacy', 'Dockerfile'));

const retailCode = retailAppPresent
  ? { codePath: retailAppDir, handler: 'src/lambda.handler' }
  : { codePath: path.resolve(__dirname, '../placeholder'), handler: 'index.handler' };

const pharmacyImage = pharmacyAppPresent
  ? {
      image: 'ftw-pharmacy:local',
      containerPort: 8080,
      entryPoint: undefined,
      command: undefined,
    }
  : {
      image: 'public.ecr.aws/docker/library/nginx:alpine',
      containerPort: 80,
      // nginx has no /health. One file makes the target group health check and
      // the smoke test both answer 200 without building an image.
      entryPoint: ['/bin/sh', '-c'],
      command: [
        "printf '%s' '{\"ok\":true,\"service\":\"pharmacy\",\"placeholder\":true}' > /usr/share/nginx/html/health && exec nginx -g 'daemon off;'",
      ],
    };

const retailBase = new BaseStack(app, 'RetailBase', {
  env,
  service: 'retail',
  cidr: '10.10.0.0/16',
  description: 'Retail network, database and NAT address. Retained across app deploys.',
  terminationProtection: true,
});

const pharmacyBase = new BaseStack(app, 'PharmacyBase', {
  env,
  service: 'pharmacy',
  cidr: '10.20.0.0/16',
  description: 'Pharmacy network, database and NAT address. Retained across app deploys.',
  terminationProtection: true,
});

const pharmacyApp = new PharmacyAppStack(app, 'PharmacyApp', {
  env,
  description: 'Pharmacy service on Fargate behind an internal ALB and an HTTP API.',
  flociPort,
  albPort,
  // The HTTP API's integration has to name a host floci itself can resolve, and
  // floci cannot resolve the load balancer's own DNS name from inside its
  // container. It publishes the listener on its own address, so this reaches the
  // same place. Unset this to get the load balancer name AWS expects.
  albIntegrationHost: process.env.ALB_INTEGRATION_HOST ?? 'floci',
  ...pharmacyImage,
});

const retailApp = new RetailAppStack(app, 'RetailApp', {
  env,
  description: 'Retail service on Lambda behind a REST API.',
  flociPort,
  ...retailCode,
});

// Each app stack needs its own base for the VPC and the database, and the other
// side's base for the address it allows. Retail additionally needs pharmacy's
// API URL, which PharmacyApp publishes, so retail goes last.
pharmacyApp.addStackDependency(pharmacyBase);
pharmacyApp.addStackDependency(retailBase);
retailApp.addStackDependency(retailBase);
retailApp.addStackDependency(pharmacyBase);
retailApp.addStackDependency(pharmacyApp);

cdk.Tags.of(app).add('project', 'floci-three-ways');
cdk.Tags.of(app).add('architecture', 'a-perimeter');

app.synth();
