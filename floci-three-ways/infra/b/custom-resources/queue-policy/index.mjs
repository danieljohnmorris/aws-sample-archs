// Applies a queue policy with sqs:SetQueueAttributes.
//
// CloudFormation's own AWS::SQS::QueuePolicy is declared alongside this in the
// messaging stack and is what would do the work on real AWS. floci creates the
// resource and reports CREATE_COMPLETE, but the queue comes back from
// GetQueueAttributes with no Policy attribute, so the policy is not readable
// and the architecture B conformance test cannot see it. This handler puts the
// same document on the queue directly.
import { SQSClient, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';

// floci injects AWS_ENDPOINT_URL and AWS_REGION into every Lambda container,
// so the default client configuration reaches it.
const sqs = new SQSClient({});

export async function handler(event) {
  const { RequestType, ResourceProperties, PhysicalResourceId } = event;
  const queueUrl = ResourceProperties?.QueueUrl;
  const physicalId = PhysicalResourceId || `queue-policy-${queueUrl}`;

  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      await sqs.send(new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: { Policy: ResourceProperties.Policy },
      }));
    }
    // Delete is a no-op. The queue is either going away with the stack or
    // keeping a policy that the next deploy will overwrite.
    return await respond(event, 'SUCCESS', physicalId, null);
  } catch (err) {
    return await respond(event, 'FAILED', physicalId, err.message);
  }
}

/**
 * Answers CloudFormation. floci reads the return value; real CloudFormation
 * reads the S3 pre-signed URL, so both are covered.
 */
async function respond(event, status, physicalId, reason) {
  const body = {
    Status: status,
    Reason: reason ?? 'see CloudWatch Logs',
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  };
  if (event.ResponseURL) {
    try {
      const payload = JSON.stringify(body);
      await fetch(event.ResponseURL, {
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(payload)) },
        body: payload,
      });
    } catch (err) {
      console.log(JSON.stringify({ msg: 'response url failed', error: err.message }));
    }
  }
  if (status === 'FAILED') throw new Error(reason ?? 'queue policy not applied');
  return body;
}
