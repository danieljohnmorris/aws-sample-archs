// Architecture B, queues between VPCs. CONTRACT.md asks for three things: both
// queues have a DLQ with maxReceiveCount 3, the queue policies name only the
// intended role ARNs, and no security group takes traffic from anywhere.
//
// Outputs read: CheckRequestQueueUrl, CheckResultQueueUrl, VpcId. RetailRoleArn
// and PharmacyRoleArn are optional; without them the principal check falls back
// to asserting every principal is a named IAM role rather than a wildcard.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { EC2Client } from '@aws-sdk/client-ec2';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  ANY_IPV4,
  ANY_IPV6,
  ingressRules,
  policyPrincipals,
  queueFacts,
  queueUrlFromArn,
  securityGroups,
} from './lib/aws.mjs';
import { archHarness, requireOutput } from './lib/config.mjs';

const harness = await archHarness('b');

describe('architecture B conformance', { skip: harness.skip }, () => {
  const outputs = harness.outputs;
  let sqs;
  let ec2;

  const queueKeys = ['CheckRequestQueueUrl', 'CheckResultQueueUrl'];

  before(() => {
    sqs = new SQSClient(harness.clientConfig);
    ec2 = new EC2Client(harness.clientConfig);
  });

  after(() => {
    sqs?.destroy();
    ec2?.destroy();
  });

  for (const key of queueKeys) {
    it(`${key} has a dead letter queue with maxReceiveCount 3`, async () => {
      const facts = await queueFacts(sqs, requireOutput(outputs, key));
      assert.ok(facts.redrivePolicy, `${key} has no RedrivePolicy`);
      assert.equal(
        Number(facts.redrivePolicy.maxReceiveCount),
        3,
        `${key} maxReceiveCount is ${facts.redrivePolicy.maxReceiveCount}`,
      );
      assert.ok(facts.redrivePolicy.deadLetterTargetArn, `${key} names no deadLetterTargetArn`);

      // The target has to be a queue that exists, not just an ARN in a string.
      const dlqUrl = await queueUrlFromArn(sqs, facts.redrivePolicy.deadLetterTargetArn);
      const dlq = await queueFacts(sqs, dlqUrl);
      assert.equal(dlq.arn, facts.redrivePolicy.deadLetterTargetArn);
      assert.equal(dlq.redrivePolicy, null, `the DLQ behind ${key} redrives somewhere else`);
    });

    it(`${key} names only the intended role ARNs`, async () => {
      const facts = await queueFacts(sqs, requireOutput(outputs, key));
      assert.ok(facts.policy, `${key} has no queue policy`);

      const principals = policyPrincipals(facts.policy);
      assert.ok(principals.length > 0, `${key} policy names no principals`);

      const wildcards = principals.filter((entry) => entry.value === '*');
      assert.deepEqual(wildcards, [], `${key} policy names a wildcard principal`);

      const expected = [outputs.RetailRoleArn, outputs.PharmacyRoleArn].filter(Boolean);
      for (const entry of principals) {
        if (entry.service) continue;
        if (expected.length > 0) {
          assert.ok(
            expected.includes(entry.value),
            `${key} policy names ${entry.value}, not one of ${expected.join(' or ')}`,
          );
        } else {
          assert.match(
            entry.value,
            /^arn:[^:]*:iam::\d{12}:role\/.+/,
            `${key} policy names ${entry.value}, which is not an IAM role ARN`,
          );
        }
      }
    });
  }

  it('the two queues are different queues', async () => {
    const request = await queueFacts(sqs, requireOutput(outputs, 'CheckRequestQueueUrl'));
    const result = await queueFacts(sqs, requireOutput(outputs, 'CheckResultQueueUrl'));
    assert.notEqual(request.arn, result.arn, 'both outputs point at the same queue');
    assert.notEqual(
      request.redrivePolicy.deadLetterTargetArn,
      result.redrivePolicy.deadLetterTargetArn,
      'both queues share one dead letter queue',
    );
  });

  it('no security group takes inbound traffic from anywhere', async () => {
    const vpcId = outputs.VpcId || null;
    const groups = await securityGroups(ec2, vpcId ? { vpcId } : {});
    assert.ok(groups.length > 0, 'no security groups found, so architecture B is not deployed');

    const open = ingressRules(groups).filter(
      (rule) => rule.cidrs.includes(ANY_IPV4) || rule.cidrsV6.includes(ANY_IPV6),
    );
    assert.deepEqual(
      open.map((rule) => `${rule.groupId} ${rule.protocol} ${rule.fromPort}-${rule.toPort}`),
      [],
      'these ingress rules are open to the world',
    );
  });
});
