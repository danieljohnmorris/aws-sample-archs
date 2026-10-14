// Simplified monolith. One app, one database, one public API. CONTRACT.md
// asks for: one VPC, one RDS instance, one function and no ECS service, no
// load balancer, no NAT gateway, no queues, and one API Gateway.
//
// Outputs read: AppVpcId, FunctionName.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DescribeLoadBalancersCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ingressRules, liveNatGateways, securityGroups } from './lib/aws.mjs';
import { archHarness, requireOutput } from './lib/config.mjs';

const harness = await archHarness('monolith');

describe('simplified monolith conformance', { skip: harness.skip }, () => {
  const outputs = harness.outputs;
  const clients = {};

  before(() => {
    clients.ec2 = new EC2Client(harness.clientConfig);
    clients.elb = new ElasticLoadBalancingV2Client(harness.clientConfig);
    clients.lambda = new LambdaClient(harness.clientConfig);
    clients.rds = new RDSClient(harness.clientConfig);
    clients.sqs = new SQSClient(harness.clientConfig);
    clients.apigateway = new APIGatewayClient(harness.clientConfig);
  });

  after(() => {
    for (const client of Object.values(clients)) client.destroy();
  });

  it('there is one VPC and no NAT gateway', async () => {
    const vpcId = requireOutput(outputs, 'AppVpcId');
    const vpcs = (await clients.ec2.send(new DescribeVpcsCommand({}))).Vpcs || [];
    assert.deepEqual(vpcs.filter((v) => !v.IsDefault).map((v) => v.VpcId), [vpcId]);
    assert.deepEqual(await liveNatGateways(clients.ec2, vpcId), []);
  });

  it('there is one database', async () => {
    const instances = (await clients.rds.send(new DescribeDBInstancesCommand({}))).DBInstances || [];
    assert.equal(instances.length, 1, JSON.stringify(instances.map((i) => i.DBInstanceIdentifier)));
  });

  it('there is one function, no load balancer and no queue', async () => {
    const functions = (await clients.lambda.send(new ListFunctionsCommand({}))).Functions || [];
    assert.deepEqual(functions.map((f) => f.FunctionName), [requireOutput(outputs, 'FunctionName')]);
    const albs = (await clients.elb.send(new DescribeLoadBalancersCommand({}))).LoadBalancers || [];
    assert.deepEqual(albs, [], 'a load balancer means there is a second service to reach');
    const queues = (await clients.sqs.send(new ListQueuesCommand({}))).QueueUrls || [];
    assert.deepEqual(queues, []);
  });

  it('there is one API and the only ingress rule is app to database', async () => {
    const apis = (await clients.apigateway.send(new GetRestApisCommand({}))).items || [];
    assert.equal(apis.length, 1, JSON.stringify(apis.map((a) => a.name)));
    const rules = ingressRules(await securityGroups(clients.ec2, { vpcId: requireOutput(outputs, 'AppVpcId') }));
    assert.equal(rules.length, 1, JSON.stringify(rules));
    assert.equal(rules[0].fromPort, 5432);
    assert.equal(rules[0].sourceGroups.length, 1);
  });
});
