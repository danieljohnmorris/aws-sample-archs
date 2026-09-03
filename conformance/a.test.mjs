// Architecture A, perimeter and addresses. CONTRACT.md asks for four things:
// the pharmacy Web ACL blocks by default, its IP set holds retail's NAT EIP,
// the retail DB security group admits only the retail app security group on
// 5432, and no IP set is open to the world.
//
// Outputs read: PharmacyWebAclArn, PharmacyIpSetArn, RetailNatEip,
// RetailDbSgId, RetailAppSgId.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { EC2Client } from '@aws-sdk/client-ec2';
import { GetWebACLCommand, GetIPSetCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { ANY_IPV4, allIpSets, ingressRules, parseWafArn, securityGroups } from './lib/aws.mjs';
import { archHarness, requireOutput } from './lib/config.mjs';

const harness = await archHarness('a');

describe('architecture A conformance', { skip: harness.skip }, () => {
  const outputs = harness.outputs;
  let waf;
  let ec2;

  before(() => {
    waf = new WAFV2Client(harness.clientConfig);
    ec2 = new EC2Client(harness.clientConfig);
  });

  after(() => {
    waf?.destroy();
    ec2?.destroy();
  });

  it('the pharmacy Web ACL blocks by default', async () => {
    const arn = parseWafArn(requireOutput(outputs, 'PharmacyWebAclArn'));
    assert.equal(arn.kind, 'webacl', 'PharmacyWebAclArn is not a Web ACL ARN');

    const answer = await waf.send(new GetWebACLCommand({ Scope: arn.scope, Name: arn.name, Id: arn.id }));
    const defaultAction = answer.WebACL?.DefaultAction;
    assert.ok(defaultAction, 'the Web ACL has no DefaultAction');
    assert.ok(
      defaultAction.Block,
      `default action is ${Object.keys(defaultAction).join(',')}, expected Block`,
    );
    assert.equal(defaultAction.Allow, undefined, 'default action allows as well as blocks');
  });

  it("the pharmacy IP set holds retail's NAT EIP", async () => {
    const arn = parseWafArn(requireOutput(outputs, 'PharmacyIpSetArn'));
    assert.equal(arn.kind, 'ipset', 'PharmacyIpSetArn is not an IP set ARN');
    const natEip = requireOutput(outputs, 'RetailNatEip');

    const answer = await waf.send(new GetIPSetCommand({ Scope: arn.scope, Name: arn.name, Id: arn.id }));
    const addresses = answer.IPSet?.Addresses || [];
    assert.equal(answer.IPSet?.IPAddressVersion, 'IPV4');
    assert.ok(
      addresses.includes(`${natEip}/32`) || addresses.includes(natEip),
      `IP set ${arn.name} holds ${JSON.stringify(addresses)}, none of them ${natEip}/32`,
    );
  });

  it('the retail DB security group admits only the retail app security group on 5432', async () => {
    const dbSgId = requireOutput(outputs, 'RetailDbSgId');
    const appSgId = requireOutput(outputs, 'RetailAppSgId');

    const groups = await securityGroups(ec2, { groupIds: [dbSgId] });
    assert.equal(groups.length, 1, `expected one security group for ${dbSgId}`);

    const rules = ingressRules(groups);
    assert.equal(rules.length, 1, `expected one ingress rule on ${dbSgId}, found ${rules.length}`);

    const [rule] = rules;
    assert.equal(rule.protocol, 'tcp');
    assert.equal(rule.fromPort, 5432);
    assert.equal(rule.toPort, 5432);
    assert.deepEqual(rule.sourceGroups, [appSgId], `source groups are ${JSON.stringify(rule.sourceGroups)}`);
    assert.deepEqual(rule.cidrs, [], 'the DB security group has a CIDR source');
    assert.deepEqual(rule.cidrsV6, [], 'the DB security group has an IPv6 CIDR source');
    assert.deepEqual(rule.prefixLists, [], 'the DB security group has a prefix list source');
  });

  it('no IP set is open to the world', async () => {
    const sets = await allIpSets(waf, 'REGIONAL');
    assert.ok(sets.length > 0, 'no regional IP sets exist, so architecture A is not deployed');
    const open = sets.filter((set) => set.addresses.includes(ANY_IPV4));
    assert.deepEqual(
      open.map((set) => set.name),
      [],
      `these IP sets contain ${ANY_IPV4}`,
    );
  });
});
