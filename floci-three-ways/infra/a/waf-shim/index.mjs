/**
 * CloudFormation custom resource that drives WAFv2 through the SDK.
 *
 * floci's CloudFormation handlers for `AWS::WAFv2::IPSet` and
 * `AWS::WAFv2::WebACLAssociation` are stubs. The IP set resource reports success
 * and returns `arn:aws:stub:::<LogicalId>` from `Fn::GetAtt`, no IP set appears
 * in `ListIPSets`, and the Web ACL rule that referenced it comes back with an
 * empty `IPSetReferenceStatement`. The association resource likewise leaves
 * `GetWebACLForResource` answering nothing.
 *
 * The same operations through the SDK all work, so this does them that way. The
 * declarative resources are still what the stack emits when the shim is off, and
 * that is the shape AWS gets. Measured 2026-09-03, see NOTES.md.
 *
 * Two actions, chosen by the `Action` property:
 *
 *   Action: 'IpSet'      Name, Scope, Addresses          returns Arn, Id, Name
 *   Action: 'Associate'  WebAclArn, ResourceArn          returns nothing
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  AssociateWebACLCommand,
  CreateIPSetCommand,
  DeleteIPSetCommand,
  DisassociateWebACLCommand,
  ListIPSetsCommand,
  UpdateIPSetCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';

const waf = new WAFV2Client({});

export async function handler(event) {
  console.log('waf-shim request', JSON.stringify({ type: event.RequestType, props: event.ResourceProperties }));
  try {
    const data = await dispatch(event);
    await respond(event, 'SUCCESS', data.physicalResourceId, data.attributes, null);
  } catch (error) {
    // Never swallow this. A failed shim must fail the stack, otherwise the
    // conformance tests read a perimeter that was never built.
    console.error('waf-shim failed', error);
    await respond(event, 'FAILED', event.PhysicalResourceId || 'waf-shim-failed', {}, String(error?.message || error));
  }
}

async function dispatch(event) {
  const props = event.ResourceProperties || {};
  if (props.Action === 'IpSet') return ipSet(event, props);
  if (props.Action === 'Associate') return associate(event, props);
  throw new Error(`unknown Action ${props.Action}`);
}

async function ipSet(event, props) {
  const { Name, Scope, Addresses } = props;
  if (!Name || !Scope || !Array.isArray(Addresses)) {
    throw new Error('IpSet needs Name, Scope and Addresses');
  }
  const physicalResourceId = `ipset:${Scope}:${Name}`;

  if (event.RequestType === 'Delete') {
    const existing = await findIpSet(Name, Scope);
    if (existing) {
      await waf.send(
        new DeleteIPSetCommand({ Name, Scope, Id: existing.Id, LockToken: existing.LockToken }),
      );
    }
    return { physicalResourceId, attributes: {} };
  }

  // Create and Update take the same path. An IP set left behind by an earlier
  // run is updated rather than treated as a collision, so a redeploy after a
  // half-finished destroy still converges.
  const existing = await findIpSet(Name, Scope);
  if (existing) {
    await waf.send(
      new UpdateIPSetCommand({
        Name,
        Scope,
        Id: existing.Id,
        Addresses,
        LockToken: existing.LockToken,
      }),
    );
    return {
      physicalResourceId,
      attributes: { Arn: existing.ARN, Id: existing.Id, Name },
    };
  }

  const created = await waf.send(
    new CreateIPSetCommand({ Name, Scope, IPAddressVersion: 'IPV4', Addresses }),
  );
  const summary = created.Summary || {};
  if (!summary.ARN) throw new Error(`CreateIPSet returned no ARN for ${Name}`);
  return {
    physicalResourceId,
    attributes: { Arn: summary.ARN, Id: summary.Id, Name },
  };
}

async function associate(event, props) {
  const { WebAclArn, ResourceArn } = props;
  if (!WebAclArn || !ResourceArn) throw new Error('Associate needs WebAclArn and ResourceArn');
  const physicalResourceId = `assoc:${ResourceArn}`;

  if (event.RequestType === 'Delete') {
    try {
      await waf.send(new DisassociateWebACLCommand({ ResourceArn }));
    } catch (error) {
      // The stage is usually deleted before this runs, and disassociating from
      // something that has gone is not a failure worth blocking a teardown on.
      // Anything else is reported.
      if (error?.name !== 'WAFNonexistentItemException') throw error;
      console.log('nothing associated to', ResourceArn);
    }
    return { physicalResourceId, attributes: {} };
  }

  await waf.send(new AssociateWebACLCommand({ WebACLArn: WebAclArn, ResourceArn }));
  return { physicalResourceId, attributes: { ResourceArn } };
}

async function findIpSet(name, scope) {
  let nextMarker;
  do {
    const page = await waf.send(new ListIPSetsCommand({ Scope: scope, NextMarker: nextMarker, Limit: 100 }));
    const found = (page.IPSets || []).find((set) => set.Name === name);
    if (found) return found;
    nextMarker = page.NextMarker;
  } while (nextMarker);
  return null;
}

function respond(event, status, physicalResourceId, data, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || 'see the log group for this function',
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  });
  const url = new URL(event.ResponseURL);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        console.log('waf-shim response', res.statusCode);
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
