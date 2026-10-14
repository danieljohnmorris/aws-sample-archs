// Simplified one VPC. Two services in one VPC, a plain HTTP call through an
// internal ALB, and nothing but security groups between them. CONTRACT.md
// asks for: one VPC, one NAT gateway, the pharmacy ALB internal and reachable
// only from retail's security group, every ingress rule SG-sourced, and none
// of C's identity layer (no pharmacy API Gateway, no queues, no custom bus).
//
// Outputs read: VpcId, PharmacyAlbArn, RetailAppSgId, PharmacyAlbSgId.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DescribeLoadBalancersCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { EventBridgeClient, ListEventBusesCommand } from '@aws-sdk/client-eventbridge';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ingressRules, liveNatGateways, securityGroups } from './lib/aws.mjs';
import { archHarness, requireOutput } from './lib/config.mjs';

const harness = await archHarness('simple-vpc');

describe('simplified one VPC conformance', { skip: harness.skip }, () => {
  const outputs = harness.outputs;
  let ec2;
  let elb;
  let apigateway;
  let sqs;
  let events;

  before(() => {
    ec2 = new EC2Client(harness.clientConfig);
    elb = new ElasticLoadBalancingV2Client(harness.clientConfig);
    apigateway = new APIGatewayClient(harness.clientConfig);
    sqs = new SQSClient(harness.clientConfig);
    events = new EventBridgeClient(harness.clientConfig);
  });

  after(() => {
    for (const client of [ec2, elb, apigateway, sqs, events]) client?.destroy();
  });

  it('there is one VPC and it is 10.70.0.0/16', async () => {
    const vpcId = requireOutput(outputs, 'VpcId');
    const answer = await ec2.send(new DescribeVpcsCommand({}));
    const ours = (answer.Vpcs || []).filter((vpc) => !vpc.IsDefault);
    assert.deepEqual(ours.map((vpc) => vpc.VpcId), [vpcId], 'expected exactly one non-default VPC');
    assert.equal(ours[0].CidrBlock, '10.70.0.0/16');
  });

  it('there is exactly one NAT gateway', async () => {
    const gateways = await liveNatGateways(ec2, requireOutput(outputs, 'VpcId'));
    assert.equal(gateways.length, 1, JSON.stringify(gateways.map((g) => g.NatGatewayId)));
  });

  it('the pharmacy ALB is internal and admits only the retail app group', async () => {
    const arn = requireOutput(outputs, 'PharmacyAlbArn');
    const answer = await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }));
    const alb = answer.LoadBalancers?.[0];
    assert.ok(alb, `no load balancer ${arn}`);
    assert.equal(alb.Scheme, 'internal');

    const albSgId = requireOutput(outputs, 'PharmacyAlbSgId');
    const retailSgId = requireOutput(outputs, 'RetailAppSgId');
    const rules = ingressRules(await securityGroups(ec2, { groupIds: [albSgId] }));
    assert.ok(rules.length > 0, 'the pharmacy ALB group has no ingress rules');
    for (const rule of rules) {
      assert.deepEqual(rule.sourceGroups, [retailSgId], `${albSgId} admits something other than retail`);
      assert.deepEqual(rule.cidrs, []);
    }
  });

  it('every ingress rule in the VPC is security-group sourced', async () => {
    const vpcId = requireOutput(outputs, 'VpcId');
    const rules = ingressRules(await securityGroups(ec2, { vpcId }));
    assert.ok(rules.length > 0, `no ingress rules in ${vpcId}`);
    const cidrSourced = rules.filter((r) => r.cidrs.length || r.cidrsV6.length || r.prefixLists.length);
    assert.deepEqual(cidrSourced.map((r) => r.groupId), [], 'these rules name a CIDR instead of a group');
  });

  it('none of the C identity layer exists: no pharmacy API, no queues, no custom bus', async () => {
    const apis = (await apigateway.send(new GetRestApisCommand({}))).items || [];
    assert.deepEqual(
      apis.map((api) => api.name).filter((name) => /pharmacy/.test(name || '')),
      [],
      'pharmacy has an API Gateway in front of it',
    );
    const queues = (await sqs.send(new ListQueuesCommand({}))).QueueUrls || [];
    assert.deepEqual(queues, [], 'there are queues');
    const buses = (await events.send(new ListEventBusesCommand({}))).EventBuses || [];
    assert.deepEqual(buses.map((b) => b.Name).filter((n) => n !== 'default'), [], 'there is a custom event bus');
  });
});
