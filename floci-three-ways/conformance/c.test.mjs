// Architecture C, identity over addresses. CONTRACT.md asks for four things:
// the pharmacy check method is AWS_IAM, every ingress rule in the VPC is
// security-group sourced, there are no NAT gateways, and the EventBridge rule
// targets a queue that has a DLQ.
//
// Outputs read: PharmacyRestApiId, VpcId, EventRuleName, EventBusName.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { EC2Client } from '@aws-sdk/client-ec2';
import { EventBridgeClient, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  ingressRules,
  isSqsArn,
  liveNatGateways,
  queueFacts,
  queueUrlFromArn,
  restApiMethod,
  restApiResources,
  securityGroups,
} from './lib/aws.mjs';
import { archHarness, requireOutput } from './lib/config.mjs';

const harness = await archHarness('c');

// CONTRACT.md writes the route as /prescriptions/{id}/check. The path parameter
// name is matched loosely so the assertion is about AWS_IAM, not the name.
const CHECK_PATH = /^\/prescriptions\/\{[^}]+\}\/check$/;

describe('architecture C conformance', { skip: harness.skip }, () => {
  const outputs = harness.outputs;
  let apigateway;
  let ec2;
  let events;
  let sqs;

  before(() => {
    apigateway = new APIGatewayClient(harness.clientConfig);
    ec2 = new EC2Client(harness.clientConfig);
    events = new EventBridgeClient(harness.clientConfig);
    sqs = new SQSClient(harness.clientConfig);
  });

  after(() => {
    apigateway?.destroy();
    ec2?.destroy();
    events?.destroy();
    sqs?.destroy();
  });

  it('the pharmacy check method requires AWS_IAM', async () => {
    const restApiId = requireOutput(outputs, 'PharmacyRestApiId');
    const resources = await restApiResources(apigateway, restApiId);

    const matches = resources.filter((resource) => CHECK_PATH.test(resource.path || ''));
    assert.equal(
      matches.length,
      1,
      `expected one /prescriptions/{id}/check resource, found ${JSON.stringify(resources.map((r) => r.path))}`,
    );

    const method = await restApiMethod(apigateway, restApiId, matches[0].id, 'GET');
    assert.equal(
      method.authorizationType,
      'AWS_IAM',
      `GET ${matches[0].path} is ${method.authorizationType}`,
    );
    // floci's GetMethod returns only httpMethod and authorizationType, so
    // apiKeyRequired cannot be asserted here. The template sets it to false.
  });

  it('every ingress rule in the VPC is security-group sourced', async () => {
    const vpcId = requireOutput(outputs, 'VpcId');
    const groups = await securityGroups(ec2, { vpcId });
    assert.ok(groups.length > 0, `no security groups in ${vpcId}`);

    const rules = ingressRules(groups);
    assert.ok(rules.length > 0, `no ingress rules in ${vpcId}, so nothing is being asserted`);

    const cidrSourced = rules.filter(
      (rule) => rule.cidrs.length > 0 || rule.cidrsV6.length > 0 || rule.prefixLists.length > 0,
    );
    assert.deepEqual(
      cidrSourced.map((rule) => `${rule.groupId} ${JSON.stringify([...rule.cidrs, ...rule.cidrsV6, ...rule.prefixLists])}`),
      [],
      'these ingress rules name a CIDR or prefix list instead of a security group',
    );

    for (const rule of rules) {
      assert.ok(
        rule.sourceGroups.length > 0,
        `${rule.groupId} has an ingress rule with no source security group`,
      );
    }
  });

  it('there are no NAT gateways', async () => {
    const vpcId = requireOutput(outputs, 'VpcId');
    const gateways = await liveNatGateways(ec2, vpcId);
    assert.deepEqual(
      gateways.map((gateway) => `${gateway.NatGatewayId} ${gateway.State}`),
      [],
      `${vpcId} has NAT gateways, so VPC endpoints are not doing the work`,
    );
  });

  it('the EventBridge rule targets a queue that has a DLQ', async () => {
    const ruleName = requireOutput(outputs, 'EventRuleName');
    const busName = requireOutput(outputs, 'EventBusName');

    const answer = await events.send(new ListTargetsByRuleCommand({ Rule: ruleName, EventBusName: busName }));
    const targets = answer.Targets || [];
    assert.ok(targets.length > 0, `${ruleName} on ${busName} has no targets`);

    const queueTargets = targets.filter((target) => isSqsArn(target.Arn));
    assert.ok(
      queueTargets.length > 0,
      `${ruleName} targets ${JSON.stringify(targets.map((t) => t.Arn))}, none of them a queue`,
    );

    for (const target of queueTargets) {
      const facts = await queueFacts(sqs, await queueUrlFromArn(sqs, target.Arn));
      assert.ok(facts.redrivePolicy, `${target.Arn} has no RedrivePolicy`);
      assert.ok(facts.redrivePolicy.deadLetterTargetArn, `${target.Arn} names no deadLetterTargetArn`);

      const dlq = await queueFacts(sqs, await queueUrlFromArn(sqs, facts.redrivePolicy.deadLetterTargetArn));
      assert.equal(dlq.arn, facts.redrivePolicy.deadLetterTargetArn);
    }
  });
});
