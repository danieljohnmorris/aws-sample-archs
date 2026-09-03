// The parsing helpers, which the architecture suites depend on but cannot
// exercise until stacks exist. No AWS calls, so this suite always runs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asArray, ingressRules, isSqsArn, parseWafArn, policyPrincipals, queueNameFromArn } from './lib/aws.mjs';

describe('parseWafArn', () => {
  it('splits a regional Web ACL ARN', () => {
    assert.deepEqual(
      parseWafArn('arn:aws:wafv2:eu-west-2:000000000000:regional/webacl/pharmacy-acl/abc-123'),
      { scope: 'REGIONAL', kind: 'webacl', name: 'pharmacy-acl', id: 'abc-123' },
    );
  });

  it('splits a regional IP set ARN', () => {
    assert.deepEqual(
      parseWafArn('arn:aws:wafv2:eu-west-2:000000000000:regional/ipset/retail-nat/def-456'),
      { scope: 'REGIONAL', kind: 'ipset', name: 'retail-nat', id: 'def-456' },
    );
  });

  it('maps the global scope to CLOUDFRONT', () => {
    assert.equal(parseWafArn('arn:aws:wafv2:us-east-1:000000000000:global/webacl/n/i').scope, 'CLOUDFRONT');
  });

  it('throws on anything else', () => {
    for (const bad of ['', 'arn:aws:sqs:eu-west-2:000000000000:q', 'not-an-arn']) {
      assert.throws(() => parseWafArn(bad), /not a WAF v2 ARN/);
    }
  });
});

describe('queueNameFromArn', () => {
  it('takes the last field', () => {
    assert.equal(queueNameFromArn('arn:aws:sqs:eu-west-2:000000000000:check-request-dlq'), 'check-request-dlq');
  });

  it('throws when there is no name', () => {
    assert.throws(() => queueNameFromArn('arn:aws:sqs:eu-west-2:000000000000:'), /not an SQS ARN/);
  });
});

describe('isSqsArn', () => {
  it('spots a queue ARN', () => {
    assert.equal(isSqsArn('arn:aws:sqs:eu-west-2:000000000000:q'), true);
  });

  it('rejects other services', () => {
    assert.equal(isSqsArn('arn:aws:lambda:eu-west-2:000000000000:function:f'), false);
  });
});

describe('ingressRules', () => {
  it('flattens permissions and keeps the group id', () => {
    const rules = ingressRules([
      {
        GroupId: 'sg-db',
        GroupName: 'retail-db',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            UserIdGroupPairs: [{ GroupId: 'sg-app' }],
            IpRanges: [],
          },
        ],
      },
    ]);
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0], {
      groupId: 'sg-db',
      groupName: 'retail-db',
      protocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      cidrs: [],
      cidrsV6: [],
      prefixLists: [],
      sourceGroups: ['sg-app'],
    });
  });

  it('surfaces an open CIDR', () => {
    const rules = ingressRules([
      { GroupId: 'sg-open', IpPermissions: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] },
    ]);
    assert.deepEqual(rules[0].cidrs, ['0.0.0.0/0']);
    assert.deepEqual(rules[0].sourceGroups, []);
  });

  it('returns nothing for a group with no rules', () => {
    assert.deepEqual(ingressRules([{ GroupId: 'sg-empty' }]), []);
  });
});

describe('policyPrincipals', () => {
  it('reads a single principal', () => {
    const principals = policyPrincipals({
      Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::000000000000:role/retail' } }],
    });
    assert.deepEqual(principals, [{ effect: 'Allow', value: 'arn:aws:iam::000000000000:role/retail' }]);
  });

  it('reads a list of principals across statements', () => {
    const principals = policyPrincipals({
      Statement: [
        { Effect: 'Allow', Principal: { AWS: ['arn:a', 'arn:b'] } },
        { Effect: 'Deny', Principal: { AWS: 'arn:c' } },
      ],
    });
    assert.deepEqual(principals.map((entry) => entry.value), ['arn:a', 'arn:b', 'arn:c']);
    assert.equal(principals[2].effect, 'Deny');
  });

  it('flags a bare wildcard principal', () => {
    assert.deepEqual(policyPrincipals({ Statement: [{ Effect: 'Allow', Principal: '*' }] }), [
      { effect: 'Allow', value: '*' },
    ]);
  });

  it('marks a service principal so the role check can skip it', () => {
    const principals = policyPrincipals({
      Statement: [{ Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' } }],
    });
    assert.equal(principals[0].service, true);
  });

  it('handles a policy with no statements', () => {
    assert.deepEqual(policyPrincipals({}), []);
    assert.deepEqual(policyPrincipals(null), []);
  });
});

describe('asArray', () => {
  it('wraps a scalar and passes a list through', () => {
    assert.deepEqual(asArray('x'), ['x']);
    assert.deepEqual(asArray(['x', 'y']), ['x', 'y']);
  });

  it('treats undefined and null as empty', () => {
    assert.deepEqual(asArray(undefined), []);
    assert.deepEqual(asArray(null), []);
  });
});
