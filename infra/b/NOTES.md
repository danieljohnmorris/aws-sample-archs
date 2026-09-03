# Architecture B on floci

Queues between two VPCs. Five stacks, one floci (`ftw-b`, endpoint
`http://localhost:4576`, IAM enforcement on), region `eu-west-2`, account
`000000000000`.

Everything below was run on 2026-09-03 against `floci/floci:latest`, CDK CLI
2.1139.0, aws-cdk-lib 2.268.0, AWS CLI 2.27.40, Docker 29.6.1 on macOS.

## Stacks

| Stack | Holds | Termination protection |
|---|---|---|
| `RetailBase` | VPC `10.10.0.0/16`, 0 NAT gateways, SQS / Secrets Manager / CloudWatch Logs interface endpoints, Postgres 16, DB secret, `/aws/lambda/ftw-b-retail-api` at 30 days | on |
| `PharmacyBase` | the same for `10.20.0.0/16` | on |
| `Messaging` | KMS key, both queues and both DLQs, queue policies, `ftw-b-retail-role`, `ftw-b-pharmacy-role`, users `retail-svc` and `pharmacy-svc` with keys in Secrets Manager | off |
| `RetailApp` | API Lambda, REST API, CheckResult consumer Lambda with an SQS event source mapping | off |
| `PharmacyApp` | Fargate worker with no load balancer, HTTP API and Lambda for seeding | off |

Nothing crosses a stack boundary as a CloudFormation export. Base stacks write
their ids to SSM; app stacks read them back through
`AWS::SSM::Parameter::Value<String>` parameters. Queue URLs, queue ARNs and
role ARNs are rebuilt from fixed names in `lib/config.ts`.

## Running it

```
make up ARCH=b
make bootstrap ARCH=b
make deploy ARCH=b        # deps, images, then cdk deploy --all
make e2e ARCH=b
make conformance ARCH=b
```

Timings on this machine, from an empty floci:

| Step | Wall clock |
|---|---|
| `make up ARCH=b` | 6 s |
| `make bootstrap ARCH=b` | 12 to 18 s (96 s on the run that pulled the CDK CLI) |
| `make deploy ARCH=b`, five stacks | 43 s, of which 33 s is CDK |
| `make e2e ARCH=b`, 7 tests | 6.6 s |
| `make conformance ARCH=b`, 24 tests | 2.1 s |
| `cdk destroy RetailApp PharmacyApp` | 27 s |
| `cdk deploy RetailApp PharmacyApp --exclusively` | 21 s |

## Deploy once per stack

floci cannot create a read-only change set, so the CDK CLI never sees "no
changes" and issues an `UpdateStack` on every stack it is asked about, whether
or not the template moved. floci's update path then re-creates the Secrets
Manager secrets, which fails because the names are taken:

```
RetailBase | UPDATE_FAILED | AWS::SecretsManager::Secret | DbSecret
  A secret with the name ftw-b/retail/db already exists.
RetailBase | UPDATE_FAILED | AWS::EC2::VPC | Vpc
  Rollback is not implemented for AWS::EC2::VPC
```

The rollback is not implemented either, so the stack lands in
`UPDATE_ROLLBACK_FAILED` and the only way out is to drop termination
protection, delete the stack and delete the retained RDS instance, secret and
log group by hand.

So: `make deploy ARCH=b` once against a given floci. To change an app stack,
destroy it and deploy it again:

```
cd infra/b
npx aws-cdk@2.1139.0 destroy RetailApp PharmacyApp --force
npx aws-cdk@2.1139.0 deploy RetailApp PharmacyApp --exclusively --require-approval never
```

`--exclusively` matters. Without it the CLI deploys the stacks those two depend
on, which is an update of the base and messaging stacks, which fails as above.

`--outputs-file` writes only the stacks in that run, so a partial deploy
truncates `outputs.json` and the tests then cannot find the queue URLs. Rebuild
the whole file from CloudFormation afterwards:

```
aws cloudformation describe-stacks --output json | python3 -c "
import json,sys
want={'RetailBase','PharmacyBase','Messaging','RetailApp','PharmacyApp'}
out={s['StackName']:{o['OutputKey']:o['OutputValue'] for o in s['Outputs']}
     for s in json.load(sys.stdin)['Stacks'] if s['StackName'] in want and s.get('Outputs')}
json.dump(out,open('infra/b/outputs.json','w'),indent=2)"
```

To start over: `make down ARCH=b && make up ARCH=b && make bootstrap ARCH=b`.

## IAM enforcement

`FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true` for this instance. The `test` key
bypasses the filter, so every check below uses the service users' keys, read
out of Secrets Manager:

```
aws secretsmanager get-secret-value --secret-id ftw-b/retail-svc   --query SecretString --output text
aws secretsmanager get-secret-value --secret-id ftw-b/pharmacy-svc --query SecretString --output text
```

On this run `retail-svc` was `AKIALGR79YA60RLJ03V6` and `pharmacy-svc` was
`AKIAE8IX44IHBW6AMKH9`. The keys are regenerated whenever the messaging stack
is created.

`retail-svc` sends and does nothing else:

```
$ aws sqs send-message --queue-url .../ftw-b-check-request --message-body '{"type":"PrescriptionCheckRequested",...}'
{
    "MD5OfMessageBody": "0558e9093ad1e14add6a1c27990f55d9",
    "MessageId": "0be8b7f0-5647-4e08-89d8-904bbf5fdef1"
}

$ aws sqs receive-message --queue-url .../ftw-b-check-request
An error occurred (AccessDeniedException) when calling the ReceiveMessage operation: User is not authorized to perform: sqs:ReceiveMessage

$ aws sqs receive-message --queue-url .../ftw-b-check-result
An error occurred (AccessDeniedException) when calling the ReceiveMessage operation: User is not authorized to perform: sqs:ReceiveMessage

$ aws sqs list-queues
An error occurred (AccessDeniedException) when calling the ListQueues operation: User is not authorized to perform: sqs:ListQueues
```

`pharmacy-svc` consumes and replies:

```
$ aws sqs receive-message --queue-url .../ftw-b-check-request --wait-time-seconds 3
None

$ aws sqs send-message --queue-url .../ftw-b-check-result --message-body '{"type":"PrescriptionCheckCompleted",...}'
{
    "MD5OfMessageBody": "a2b509f741aabc3de2e01463db6ce752",
    "MessageId": "4892bd1b-1d90-451e-9975-7faa2e25ca40"
}

$ aws sqs purge-queue --queue-url .../ftw-b-check-request
An error occurred (AccessDeniedException) when calling the PurgeQueue operation: User is not authorized to perform: sqs:PurgeQueue
```

The receive returns `None` rather than an error: the call was allowed, and the
Fargate worker had already taken the message. The `test` key receives from the
same queue with no error at all, which is the bypass the day-one notes
describe.

Two things this cannot show. First, the third denial in the retail set is
`sqs:ReceiveMessage` on CheckResult, which reads like retail being locked out
of its own reply queue. It is not: floci resolves every SQS request to the
wildcard queue ARN, so enforcement is action-level and a user either holds
`ReceiveMessage` everywhere or nowhere. `retail-svc` does not hold it because
retail's inbound path is the event source mapping on CheckResult, which floci
polls with its own credentials. Second, there is no mirror denial for
`pharmacy-svc` on `sqs:SendMessage`, because pharmacy has to send to reply.
`sqs:PurgeQueue` is the nearest thing to a mirror that is real.

The `ftw-b-retail-role` and `ftw-b-pharmacy-role` policies carry the same
statements as their users, except that the retail role also holds the consume
actions, because on AWS an event source mapping runs under the function's role.

Every SQS statement uses `Resource: "arn:aws:sqs:eu-west-2:000000000000:*"`.
Naming a queue produces a denial on every call. See the IAM enforcement section
of `docs/day-one-floci-checks.md`.

## Queue policies are declared and applied twice

The queue policies name only the two role ARNs, which is what the architecture
B conformance test reads. `AWS::SQS::QueuePolicy` is created by floci and
reported `CREATE_COMPLETE` with a physical id, but the queue then answers
`GetQueueAttributes` with no `Policy` attribute, so nothing can read the policy
back. `SetQueueAttributes` with the same document works and is readable.

`Messaging` therefore declares both: the CloudFormation resource, which is what
does the work on AWS, and a small custom resource
(`custom-resources/queue-policy`) that calls `SetQueueAttributes` with the same
document, which is what makes it observable here. The two share one
`PolicyDocument`, so they cannot drift.

CDK's own `AwsCustomResource` does not work on this floci. Its handler resolves
`sqs.eu-west-2.amazonaws.com` to floci's container IP and then tries port 443:

```
Custom resource handler errored (Handled):
{"errorType":"Error","errorMessage":"connect ECONNREFUSED 172.25.0.2:443"}
```

Setting `AWS_ENDPOINT_URL` on its provider function did not change that. A
plain Lambda with an ordinary SDK v3 client works, because floci injects
`AWS_ENDPOINT_URL=http://floci:4566` into Lambda containers itself. floci
invokes custom resources and reads the return value; the handler also PUTs to
`ResponseURL` when there is one, so it behaves on AWS.

## Dead letter queue and redrive

Both queues redrive to a DLQ at `maxReceiveCount` 3, visibility timeout 30 s.
A message the pharmacy consumer cannot parse takes about 90 s to exhaust its
three receives.

```
$ aws sqs send-message --queue-url .../ftw-b-check-request \
    --message-body '{"type":"PrescriptionCheckRequested","prescriptionId":"RX-POISON"}'
fc89314d-b1cd-469b-9299-ad8b1fa4e378

  t+10s dead letter queue depth: 0
  ...
  t+80s dead letter queue depth: 0
  t+90s dead letter queue depth: 1

$ aws sqs receive-message --queue-url .../ftw-b-check-request-dlq --query 'Messages[0].Body' --output text
{"type":"PrescriptionCheckRequested","prescriptionId":"RX-POISON"}

$ aws sqs start-message-move-task \
    --source-arn arn:aws:sqs:eu-west-2:000000000000:ftw-b-check-request-dlq
{
    "TaskHandle": "task-292d7b6f-a7f4-44fa-97de-3b5007d05053"
}

$ aws sqs get-queue-attributes --queue-url .../ftw-b-check-request-dlq \
    --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text
0

$ aws sqs list-message-move-tasks --source-arn arn:aws:sqs:eu-west-2:000000000000:ftw-b-check-request-dlq
{
    "Results": [
        {
            "TaskHandle": "task-292d7b6f-a7f4-44fa-97de-3b5007d05053",
            "Status": "COMPLETED",
            "ApproximateNumberOfMessagesMoved": 1,
            "ApproximateNumberOfMessagesToMove": 1
        }
    ]
}
```

Redrive is a manual step here, not a schedule. The poison message goes back on
the source queue and fails again, which is what you want while you are deciding
whether to fix the consumer or drop the message.

## Destroying the app stacks

```
$ npx aws-cdk@2.1139.0 destroy RetailApp PharmacyApp --force
✅  RetailApp: destroyed
✅  PharmacyApp: destroyed
```

Gone: both Lambdas, the retail REST API, the pharmacy HTTP API, the ECS
cluster, service and task, the event source mapping.

Still there:

| Survivor | State after the destroy |
|---|---|
| `RetailBase`, `PharmacyBase`, `Messaging` | `CREATE_COMPLETE` |
| `ftw-b-retail`, `ftw-b-pharmacy` Postgres | `available` |
| Both VPCs | present |
| All four queues | present, with their policies still set |
| `/aws/lambda/ftw-b-retail-api`, `/aws/lambda/ftw-b-pharmacy-api` | present, retention 30 days |
| Every `/ftw-b/*` SSM parameter | present |
| `ftw-b-queue-policy-applier` | present, it belongs to `Messaging` |

Redeploying the two app stacks took 21 s, and e2e and conformance were green
again with no other change. The base stacks were never touched, so the RDS
instances kept their data: the prescriptions and orders from the previous run
were still in place.

## Other floci behaviour worth knowing

**The bootstrapped roles are denied everything under IAM enforcement.** CDK's
default synthesiser assumes `cdk-hnb659fds-file-publishing-role-...` to upload
assets. That role is denied:

```
$ aws s3api get-bucket-location --bucket cdk-hnb659fds-assets-000000000000-eu-west-2
An error occurred (AccessDenied) when calling the GetBucketLocation operation: User is not authorized to perform: s3:ListBucket
```

The role's policy is stored with its intrinsics unresolved. `get-role-policy`
returns `"Resource": [{"Fn::Sub": "${StagingBucket.Arn}"}, ...]`, so the filter
has no ARN to match. The app uses `CliCredentialsStackSynthesizer`, which
publishes and deploys with the caller's own key.

The same trap applies to any policy written here: a `Resource` that is an
`Fn::GetAtt` will never match. Every statement in `Messaging` uses either a
literal ARN or `*`.

**Dynamic references are not resolved.** `{{resolve:ssm:/name}}` and
`{{resolve:secretsmanager:name:SecretString:key}}` arrive at the resource as
those literal strings. A CloudFormation parameter of type
`AWS::SSM::Parameter::Value<String>` is resolved. Probe:

| Property | Result |
|---|---|
| `QueueName: "probe-dyn-{{resolve:ssm:/probe/src}}"` | queue named `probe-dyn-{{resolve:ssm:/probe/src}}` |
| `QueueName: "probe-sec-{{resolve:secretsmanager:probe/creds:SecretString:k}}"` | queue named with the literal too |
| `QueueName: {"Fn::Sub": "probe-param-${SubnetParam}"}`, parameter type `AWS::SSM::Parameter::Value<String>` | queue named `probe-param-abc123` |

That is why every id crossing a stack boundary here is an SSM parameter read
through a CloudFormation parameter.

**`rds.Credentials.fromSecret` does not work.** It adds an
`AWS::SecretsManager::SecretTargetAttachment`, which fails with `DB instance
ftw-b-retail not found` even with the instance `available`. The DB secret is
written directly and the instance takes the same password through
`rds.Credentials.fromPassword`. The passwords live in `infra/b/.env`, which is
committed because floci is a local emulator on a throwaway account, and because
the app stacks build `DATABASE_URL` from them at synth time.

**RDS works.** Both instances reach `available` in about a minute as
`postgres:16.4-alpine` containers, on `localhost:7011` and `localhost:7012`.
Lambda and ECS reach them as `floci:7011` and `floci:7012`. The port is
allocated at create time, so it is published as `/ftw-b/<service>/db-port` and
read back into `DATABASE_URL`.

**REST APIs and HTTP APIs are served on different URLs.** An HTTP API answers
at `http://<id>.execute-api.localhost.floci.io:4576`. The same shape against a
REST API is read as a virtual-host S3 bucket and returns `NoSuchBucket`. REST
answers at `http://localhost:4576/restapis/<id>/prod/_user_request_`, which is
what `RetailApiUrl` carries.

**Event source mappings work.** No poller was needed. A message put on
CheckResult reached `ftw-b-retail-result-consumer` and the record appeared in
its log group within seconds.

**ECS runs a locally built image tag.** `ftw-pharmacy:local` is built by
`make images` and used as-is; floci pulls nothing and needs no push to an ECR
registry, because the Docker socket is mounted into the floci container. The
container shows up as `floci-ecs-<task-id>-worker` on `ftw-b_default`.

**ECS resolves task definition secrets.** `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` come from the `ftw-b/pharmacy-svc` secret through the
task definition's `Secrets` field and arrive in the container as values.

**Lambda accepts reserved environment variable names.** Real Lambda rejects
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and
`AWS_SESSION_TOKEN` in a function's environment, and CDK refuses to synthesise
them. floci takes them. They are set through `addPropertyOverride` on the
`CfnFunction`, which is the only way past CDK's check.

**Termination protection is honoured.**

```
$ aws cloudformation delete-stack --stack-name RetailBase
An error occurred (ValidationError) when calling the DeleteStack operation:
Stack [...] cannot be deleted while TerminationProtection is enabled
```

**`ec2:DescribeAvailabilityZones` fails from a CDK context lookup**, though it
works from the CLI. The availability zones are pinned in `cdk.json` so nothing
looks them up.

**ECS logs.** floci creates `/ecs/ftw-b-pharmacy-worker` of its own accord
alongside the `/ftw-b/pharmacy-worker` group the stack declares, and ships
nothing to either. The contract already says ECS logs are not shipped, so step
7 of the scenario reads the retail Lambda's group.
