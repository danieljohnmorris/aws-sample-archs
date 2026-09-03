// Shared readers. Each one asks the SDK and hands back a plain object, so the
// test files stay assertions.
import { GetMethodCommand, GetResourcesCommand } from '@aws-sdk/client-api-gateway';
import { DescribeNatGatewaysCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { GetIPSetCommand, ListIPSetsCommand } from '@aws-sdk/client-wafv2';

export const ANY_IPV4 = '0.0.0.0/0';
export const ANY_IPV6 = '::/0';

/**
 * Splits a WAF v2 ARN into the three things GetWebACL and GetIPSet want.
 * Shape: arn:aws:wafv2:<region>:<account>:regional/webacl/<name>/<id>
 */
export function parseWafArn(arn) {
  const match = String(arn).match(/^arn:[^:]*:wafv2:[^:]*:[^:]*:(regional|global)\/(webacl|ipset)\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`not a WAF v2 ARN: ${arn}`);
  return {
    scope: match[1] === 'global' ? 'CLOUDFRONT' : 'REGIONAL',
    kind: match[2],
    name: match[3],
    id: match[4],
  };
}

/** Last colon-separated field of an SQS ARN is the queue name. */
export function queueNameFromArn(arn) {
  const parts = String(arn).split(':');
  const name = parts[parts.length - 1];
  if (!name) throw new Error(`not an SQS ARN: ${arn}`);
  return name;
}

export function isSqsArn(arn) {
  return /^arn:[^:]*:sqs:/.test(String(arn));
}

/** Queue attributes with RedrivePolicy and Policy already parsed. */
export async function queueFacts(sqs, queueUrl) {
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
  );
  const all = attributes.Attributes || {};
  return {
    queueUrl,
    arn: all.QueueArn,
    redrivePolicy: all.RedrivePolicy ? JSON.parse(all.RedrivePolicy) : null,
    policy: all.Policy ? JSON.parse(all.Policy) : null,
    attributes: all,
  };
}

/** Resolves an SQS ARN to a queue URL so its own attributes can be read. */
export async function queueUrlFromArn(sqs, arn) {
  const answer = await sqs.send(new GetQueueUrlCommand({ QueueName: queueNameFromArn(arn) }));
  return answer.QueueUrl;
}

/** Every IP set in the regional scope, addresses included. */
export async function allIpSets(waf, scope = 'REGIONAL') {
  const sets = [];
  let marker;
  do {
    const page = await waf.send(new ListIPSetsCommand({ Scope: scope, NextMarker: marker, Limit: 100 }));
    for (const summary of page.IPSets || []) {
      const detail = await waf.send(
        new GetIPSetCommand({ Scope: scope, Name: summary.Name, Id: summary.Id }),
      );
      sets.push({ name: summary.Name, id: summary.Id, addresses: detail.IPSet?.Addresses || [] });
    }
    marker = page.NextMarker;
  } while (marker);
  return sets;
}

/** Security groups in one VPC, or by explicit ids. */
export async function securityGroups(ec2, { vpcId, groupIds } = {}) {
  const input = {};
  if (groupIds) input.GroupIds = groupIds;
  if (vpcId) input.Filters = [{ Name: 'vpc-id', Values: [vpcId] }];
  const groups = [];
  let token;
  do {
    const page = await ec2.send(new DescribeSecurityGroupsCommand({ ...input, NextToken: token }));
    groups.push(...(page.SecurityGroups || []));
    token = page.NextToken;
  } while (token);
  return groups;
}

/** Flattens ingress rules into one row per rule, so failures name the group. */
export function ingressRules(groups) {
  const rules = [];
  for (const group of groups) {
    for (const permission of group.IpPermissions || []) {
      rules.push({
        groupId: group.GroupId,
        groupName: group.GroupName,
        protocol: permission.IpProtocol,
        fromPort: permission.FromPort,
        toPort: permission.ToPort,
        cidrs: (permission.IpRanges || []).map((range) => range.CidrIp),
        cidrsV6: (permission.Ipv6Ranges || []).map((range) => range.CidrIpv6),
        prefixLists: (permission.PrefixListIds || []).map((entry) => entry.PrefixListId),
        sourceGroups: (permission.UserIdGroupPairs || []).map((pair) => pair.GroupId),
      });
    }
  }
  return rules;
}

/** NAT gateways in a VPC that are alive. Deleted ones linger in describe output. */
export async function liveNatGateways(ec2, vpcId) {
  const filters = [{ Name: 'state', Values: ['pending', 'available'] }];
  if (vpcId) filters.push({ Name: 'vpc-id', Values: [vpcId] });
  const gateways = [];
  let token;
  do {
    const page = await ec2.send(new DescribeNatGatewaysCommand({ Filter: filters, NextToken: token }));
    gateways.push(...(page.NatGateways || []));
    token = page.NextToken;
  } while (token);
  return gateways;
}

/** Every resource on a REST API, keyed by path. */
export async function restApiResources(apigateway, restApiId) {
  const resources = [];
  let position;
  do {
    const page = await apigateway.send(
      new GetResourcesCommand({ restApiId, limit: 500, position }),
    );
    resources.push(...(page.items || []));
    position = page.position;
  } while (position);
  return resources;
}

export async function restApiMethod(apigateway, restApiId, resourceId, httpMethod) {
  return apigateway.send(new GetMethodCommand({ restApiId, resourceId, httpMethod }));
}

/** Principals named by a queue policy, flattened across statements. */
export function policyPrincipals(policy) {
  const principals = [];
  for (const statement of asArray(policy?.Statement)) {
    const principal = statement.Principal;
    if (principal === '*') {
      principals.push({ effect: statement.Effect, value: '*' });
      continue;
    }
    for (const value of asArray(principal?.AWS)) {
      principals.push({ effect: statement.Effect, value });
    }
    for (const value of asArray(principal?.Service)) {
      principals.push({ effect: statement.Effect, value, service: true });
    }
  }
  return principals;
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
