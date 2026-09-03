// Placeholder retail handler, replaced by apps/retail once it lands on main.
// The stack picks the real code up automatically when apps/retail/src exists.
//
// /whoami and /put-event are here to answer one question the day-one floci
// notes left open: whether floci hands a Lambda its execution role's
// credentials and evaluates them under IAM enforcement.
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function whoami() {
  const out = { placeholder: true };
  out.accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? null;
  out.hasSessionToken = Boolean(process.env.AWS_SESSION_TOKEN);
  out.endpoint = process.env.AWS_ENDPOINT_URL ?? null;
  try {
    const sts = new STSClient({});
    const id = await sts.send(new GetCallerIdentityCommand({}));
    out.callerArn = id.Arn ?? null;
  } catch (err) {
    out.callerArn = `error: ${err.name}: ${err.message}`;
  }
  return out;
}

async function putEvent(detail) {
  const client = new EventBridgeClient({});
  const res = await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.EVENT_BUS_NAME,
          Source: 'retail',
          DetailType: 'OrderPlaced',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
  return { failedEntryCount: res.FailedEntryCount, entries: res.Entries };
}

export const handler = async (event) => {
  const path = event.path ?? event.rawPath ?? '/';
  if (path.endsWith('/health')) {
    return json(200, { ok: true, service: 'retail', placeholder: true });
  }
  if (path.endsWith('/whoami')) {
    return json(200, await whoami());
  }
  if (path.endsWith('/put-event')) {
    const detail = event.body ? JSON.parse(event.body) : { probe: true };
    try {
      return json(200, { put: await putEvent(detail) });
    } catch (err) {
      return json(500, { error: `${err.name}: ${err.message}` });
    }
  }
  if (path.endsWith('/call-pharmacy')) {
    const url = `${process.env.PHARMACY_BASE_URL}/health`;
    try {
      const res = await fetch(url);
      return json(200, { url, status: res.status, body: await res.text() });
    } catch (err) {
      return json(500, { url, error: `${err.name}: ${err.message}` });
    }
  }
  return json(501, { error: 'not implemented', placeholder: true, path });
};
