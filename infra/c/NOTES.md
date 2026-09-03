# Architecture C on floci: what happened

Architecture C is identity over addresses. One VPC, no NAT gateways, no CIDR in
any ingress rule, callers identified by IAM role, EventBridge for the audit
trail. This file records what floci does with that, and where the design and
the emulator stop agreeing.

Measured on 2026-09-03. `floci/floci:latest`, image `4e451c39c7bb`, version
2.0.1, community edition. Docker 29.6.1 on macOS, AWS CLI 2.27.40, Node
v24.9.0, CDK CLI 2.1139.0, aws-cdk-lib 2.268.0, constructs 10.8.1. Region
`eu-west-2`, account `000000000000`, floci project `ftw-c` on port 4586 with
`FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true`.

Everything below was run and observed here.

## Layout

Four stacks. Two hold state and are meant to outlive the other two.

| Stack | Holds |
|---|---|
| `SharedBase` | VPC, six security groups, six interface endpoints and the S3 gateway endpoint, two Postgres 16 instances, SSM parameters for the ids. Termination protection on, databases RETAIN. |
| `Events` | `orders` bus, archive, rule `order-events`, the `order-events` queue with its DLQ, and a separate rule DLQ. |
| `PharmacyApp` | ECS Fargate service behind an internal ALB, the REST API with `AWS_IAM` on every method, and the HTTP API that carries traffic on floci. |
| `RetailApp` | Lambda in the private subnets, the customer-facing REST API, the WAF Web ACL, the retail role and the `retail-svc` fallback user. |

`PharmacyApp` does not import anything from `RetailApp`. The retail role has a
fixed name, `ftw-c-retail-lambda`, so the pharmacy resource policy can name its
ARN without the two stacks forming a cycle.

## Running it

```
make up ARCH=c
make bootstrap ARCH=c
make deploy ARCH=c        # deps, images, cdk deploy --all, writes outputs.json
make e2e ARCH=c
make conformance ARCH=c
```

`make deploy ARCH=c` works on a floci that has never held these stacks. It does
not work a second time, because floci cannot update a CloudFormation stack. To
replace the two app stacks:

```
cd infra/c
npx aws-cdk@2.1139.0 destroy --exclusively RetailApp PharmacyApp --force
aws iam delete-user --user-name ftw-c-retail-svc   # after removing its key and policy
npx aws-cdk@2.1139.0 deploy --exclusively PharmacyApp RetailApp \
  --require-approval never --outputs-file /tmp/app-out.json
```

`--exclusively` is what keeps CDK from re-submitting `SharedBase`. Merge
`/tmp/app-out.json` into `outputs.json` afterwards, or take the shortcut:
`RetailApp` repeats `VpcId`, `EventBusName` and `EventRuleName` so a partial
outputs file still carries every key the tests read.

`infra/c/.env` holds two values the stacks read at synth: `PAYMENT_WEBHOOK_SECRET`
and `DB_PASSWORD`. Reasons under "Dynamic references" below.

## Timings

| Step | Wall clock |
|---|---|
| `make up ARCH=c` | 6s |
| `make bootstrap ARCH=c` | 12s |
| `make deploy ARCH=c` from clean, all four stacks | 37s, of which CDK reports 21s |
| `cdk deploy --all` alone, assets already built | 10s |
| `cdk destroy --exclusively RetailApp PharmacyApp` | 18s to 30s across three runs |
| `cdk deploy --exclusively PharmacyApp RetailApp` | 10s, of which CDK reports 7s |
| `make e2e ARCH=c`, 7 tests | 0.7s to 1.5s |

The two RDS instances reach `available` inside the deploy. Both databases come
up as real `postgres:16.4-alpine` containers on ports 7021 and 7022.

## What survives a destroy of the two app stacks

Destroyed `RetailApp` and `PharmacyApp`, then read the account back.

Still there: stacks `SharedBase` and `Events`; VPC `10.60.0.0/16` with four
subnets, six interface endpoints and the S3 gateway endpoint; all six security
groups with their seven ingress rules; both RDS instances `available`; both
database secrets; the `orders` bus; all three queues.

Gone: the ALB, the ECS cluster and service, the Lambda, both pharmacy APIs, the
retail API, the Web ACL, the retail role and its policy.

Left behind by floci: the IAM user `ftw-c-retail-svc`. See below.

After the redeploy, `make e2e ARCH=c` passed all seven steps again.

## Which IAM path was evaluated

The execution role, and only because floci does not evaluate it.

floci starts the Lambda with credentials for
`arn:aws:sts::000000000000:assumed-role/ftw-c-retail-lambda/floci-session`.
`sts get-caller-identity` with those credentials returns that ARN. So the role
is the identity floci reports.

It is not the identity floci enforces. Taking the credentials out of the Lambda
container and calling `sqs:ListQueues` and `s3:ListBuckets`, neither of which
the role policy allows, both returned data. Nothing was denied and floci logged
no `IamEnforcementFilter` line, with enforcement on.

The `retail-svc` user is the other half of the answer. Its keys are evaluated:

| Call as `ftw-c-retail-svc` | Result |
|---|---|
| `sqs:ListQueues`, not in the policy | `AccessDeniedException` |
| `s3:ListBuckets`, not in the policy | `AccessDenied` |
| `events:PutEvents` on `orders`, allowed by the policy on the bus ARN | `AccessDeniedException` |

The third row is the interesting one. floci's log says why:

```
IamEnforcementFilter IAM enforcement DENY: akid=AKIA8PFGNWZ46MSOXIV5 action=events:PutEvents resource=*
```

The filter resolves a `PutEvents` call to the wildcard resource, so a policy
naming `arn:aws:events:eu-west-2:000000000000:event-bus/orders` never matches.
This is the same resource-resolution behaviour the day-one notes recorded for
SQS, now confirmed for EventBridge.

So the static-key path is not a fallback here, it is a way to break the app.
`useStaticKeys` stays off. Deploy with `-c useStaticKeys=true` to put the keys
in the Lambda environment, and widen `events:PutEvents` to `Resource: "*"` at
the same time, or retail cannot publish.

floci also sets `AWS_REGION` and `AWS_DEFAULT_REGION` in the Lambda container
itself, so SigV4 signing has a region without the stack doing anything. CDK
refuses both names in `environment` because Lambda reserves them; the stack has
a `forceRegionEnv` context flag that writes them through a CloudFormation
property override, and it is off because it is not needed. The ECS task sets
both explicitly, because floci does not inject them there.

## Where the design and the emulator part ways

### AWS_IAM on API Gateway is not enforced

An unsigned `GET /health` from a plain container on `ftw-c_default` returns 200:

```
$ docker run --rm --network ftw-c_default curlimages/curl -s \
    http://floci:4566/restapis/<id>/prod/_user_request_/health
{"ok":true,"service":"pharmacy"}
```

Every method on that API declares `authorizationType: AWS_IAM` and the REST
API's resource policy allows one principal, the retail role. Neither gates the
request. This matches the day-one finding and it is the single largest gap
between architecture C as designed and architecture C as run here.

What the conformance test asserts instead is the configuration:
`GET /prescriptions/{id}/check` comes back from `apigateway get-method` with
`authorizationType: AWS_IAM`. The resource policy cannot be asserted the same
way, because floci does not return it (below).

### floci's REST API Gateway cannot run an HTTP_PROXY integration

This is new, and it changed the shape of the stack.

```
$ curl http://localhost:4586/restapis/<rest-api-id>/prod/_user_request_/health
{"message":"Unsupported integration type: HTTP_PROXY"}   HTTP 500
```

`HTTP` gives the same answer. Only `AWS_PROXY` and `MOCK` appear in the REST
controller's supported set, and the retail API works because it is `AWS_PROXY`
to a Lambda. The HTTP API implementation does run `HTTP_PROXY`.

So `PharmacyApp` builds two APIs:

- `ftw-c-pharmacy`, REST v1, `HTTP_PROXY` to the ALB DNS name, `AWS_IAM` on
  every method, resource policy naming the retail role. This is the design and
  what conformance reads. `PharmacyRestApiId` and `PharmacyRestApiUrl` point at
  it. No request can pass through it on floci.
- `ftw-c-pharmacy-http`, HTTP API v2, the same three routes, `AWS_IAM` on each,
  `HTTP_PROXY` to the ALB listener. This carries the traffic. `PharmacyApiUrl`
  and `PHARMACY_BASE_URL` point at it. On AWS it would not exist.

### The ALB DNS name resolves for some callers and not others

`ftw-c-pharmacy-alb-<suffix>.elb.floci` is answered by floci's embedded DNS for
containers floci starts. It is not answered for a plain `docker run` container
on the same network, and it is not answered by floci's own HTTP client:

| Caller | `http://<alb>.elb.floci:8100/` |
|---|---|
| floci's ALB health checker | 200 |
| plain container on `ftw-c_default` | curl exit 6, could not resolve host |
| API Gateway HTTP_PROXY integration | 502 `Bad Gateway: null` |

`http://floci:8100/` works from all three, because the ALB listener is
published on floci itself. The REST integration keeps the ALB DNS name, since
that is the correct address on AWS. The HTTP API integration uses
`http://floci:8100`, or nothing reaches pharmacy.

Cloud Map was not used at all, per the day-one finding that its DNS does not
resolve.

### The invoke URL is the path form, not the subdomain

`<id>.execute-api.localhost.floci.io:4586` is answered by floci's S3
virtual-host handler and returns `NoSuchBucket`, for REST APIs and for HTTP
APIs alike when the caller reaches it over the published port. The form that
works everywhere is:

```
http://localhost:4586/restapis/<id>/prod/_user_request_/<path>     from the host
http://floci:4566/restapis/<id>/prod/_user_request_/<path>         from a container
```

Both `RetailApiUrl` and `PharmacyApiUrl` use the first. `PHARMACY_BASE_URL`
uses the second. floci is on 4566 inside its own network whatever port the host
publishes.

### CloudFormation cannot update a stack

Every stack update re-runs create on the resources, so anything with a name
fails the second time:

```
SharedBase | UPDATE_FAILED | AWS::SecretsManager::Secret | A secret with the name ftw-c/retail/db already exists.
SharedBase | UPDATE_FAILED | AWS::EC2::VPC | Rollback is not implemented for AWS::EC2::VPC
```

`ContinueUpdateRollback` is not supported either, so a stack that fails an
update is stuck in `UPDATE_ROLLBACK_FAILED` and has to be deleted. Deleting a
stack with termination protection needs
`update-termination-protection --no-enable-termination-protection` first.

The trap is that `cdk deploy PharmacyApp` pulls `SharedBase` into the deploy
set as a dependency and submits an update to it even when the template has not
changed. That is what `--exclusively` avoids.

### CloudFormation does not resolve dynamic references

`{{resolve:secretsmanager:...}}` arrives in the Lambda environment as literal
text:

```
DATABASE_URL=postgres://retail:{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-2:000000000000:secret:ftw-c/retail/db-ETYUR0:SecretString:password::}}@floci:7021/retail
```

Every database connection and every webhook signature check failed on that.
The fix is to supply both values at synth time from `infra/c/.env`, as
`DB_PASSWORD` and `PAYMENT_WEBHOOK_SECRET`. The secrets are still created in
Secrets Manager and the retail role still has `GetSecretValue` on them, so the
design is intact; the values just do not travel through a dynamic reference.

### SecretTargetAttachment fails against a database that exists

`rds.Credentials.fromGeneratedSecret` adds an
`AWS::SecretsManager::SecretTargetAttachment`, and it failed with:

```
CREATE_FAILED | AWS::SecretsManager::SecretTargetAttachment | DB instance sharedbase-retaildba66acbf2-3b11739aa08d not found.
```

while `describe-db-instances` reported that exact identifier as `available`.
`SharedBase` creates the secret itself and passes the password to RDS with
`Credentials.fromPassword`, which produces no attachment.

### Resources CloudFormation reports as created but does not create

Both report `CREATE_COMPLETE` with an invented physical id and leave nothing
behind in the service:

| Resource | Evidence |
|---|---|
| `AWS::Events::Archive` | `list-archives` returns `[]`, `describe-archive --archive-name orders-archive` returns `ResourceNotFoundException`. `aws events create-archive` on the same bus works and lists. |
| `AWS::WAFv2::WebACLAssociation` | `get-web-acl-for-resource` on the retail stage returns null. `aws wafv2 associate-web-acl` with the same two ARNs works, and the stage then reports the ACL. |

The Web ACL itself is created and readable, with both rules. Associating it
after a `RetailApp` deploy is a manual step:

```
aws wafv2 associate-web-acl \
  --web-acl-arn "$(aws wafv2 list-web-acls --scope REGIONAL --query 'WebACLs[0].ARN' --output text)" \
  --resource-arn "arn:aws:apigateway:eu-west-2::/restapis/<retail-api-id>/stages/prod"
```

Neither the ACL nor the association filters traffic, so this changes what the
configuration says, not what gets through.

### get-rest-api does not return the resource policy

The template carries the policy, CloudFormation accepts it, and
`aws apigateway get-rest-api` returns `id`, `name`, `description` and
`endpointConfiguration` with no `policy` field. A conformance test cannot read
the principal back through the SDK. The synthesised template in
`infra/c/cdk.out/PharmacyApp.template.json` is where it can be checked:

```json
{"Action":"execute-api:Invoke","Effect":"Allow",
 "Principal":{"AWS":"arn:aws:iam::000000000000:role/ftw-c-retail-lambda"},
 "Resource":"execute-api:/*"}
```

### get-method does not return apiKeyRequired

Whatever the template or the API says. Put a method with
`--api-key-required` and one with `--no-api-key-required`, and `get-method`
returns `httpMethod` and `authorizationType` for both and nothing else. The
stack sets `apiKeyRequired: false` explicitly and the field is in
`PharmacyApp.template.json`; floci still omits it. This is the one conformance
assertion that cannot pass, see below.

### cdk bootstrap roles are denied under IAM enforcement

The first asset publish failed with

```
Bucket named 'cdk-hnb659fds-assets-000000000000-eu-west-1' exists, but we dont have access to it.
IamEnforcementFilter IAM enforcement DENY: akid=ASIA... action=s3:ListBucket resource=arn:aws:s3:::cdk-hnb659fds-assets-000000000000-eu-west-1/
```

Note the trailing slash on the resource ARN. The bootstrap file-publishing
role's policy names the bucket without it, so the allow never matches. The app
uses `CliCredentialsStackSynthesizer`, which publishes and deploys with the CLI
credentials rather than assuming the bootstrap roles. The CLI key is `test`,
which bypasses enforcement.

### floci leaves resources behind

- `AWS::IAM::User` is not deleted when the stack is deleted. `ftw-c-retail-svc`
  survived every destroy and blocked the next deploy with "already exists". Its
  access key and inline policy have to go first, then the user.
- The previous task's container keeps running when the Fargate service is
  replaced. `docker ps` showed two `ftw-pharmacy:local` containers for a service
  with `desiredCount: 1`.
- `make down ARCH=c` removes the network before the filter that cleans up
  `floci-*` containers can match on it, so a few are left running.

### An updated PharmacyApp points its listener at an empty target group

Observed once, after `cdk deploy --exclusively PharmacyApp RetailApp` was run against a floci that already held both stacks. floci reported `UPDATE_COMPLETE`, but the ALB listener's default action named a target group (`…-fa438495`) that was not the one holding the healthy task (`…-71b44655`). The HTTP API answered `No targets available`, 503, and every order step failed. `describe-target-health` on the old group still showed one healthy target. Destroying both app stacks, removing the stray `floci-ecs-*` containers on `ftw-c_default`, deleting the leftover IAM user and deploying again fixed it. Do not update PharmacyApp in place on floci.

### Smaller things

- CDK's `Vpc` accepts `natGateways: 0` alongside `PRIVATE_WITH_EGRESS` subnets
  as long as there are no public subnets. `createInternetGateway: false` is set
  as well, so the VPC has no gateway of any kind and no route to `0.0.0.0/0`.
- ECS takes a local image tag straight from the mounted Docker socket.
  `ftw-pharmacy:local`, built by `make images`, runs without any push. The only
  ECR repository in the account is the CDK bootstrap one, unused.
- Container logging is left off the pharmacy task. floci does not ship container
  stdout to CloudWatch, and the `awslogs` driver would only add a failure mode.
- Queue URLs come back as `http://floci:4566/...`, which a test on the host
  cannot use directly. Swap the host and port for `localhost:4586`.

## Test results

`make e2e ARCH=c`: 7 of 7 pass, before and after the destroy and redeploy.

`make conformance ARCH=c`: 3 of the 4 architecture C assertions pass.

| Assertion | Result |
|---|---|
| every ingress rule in the VPC is security-group sourced | pass, seven rules, none CIDR-sourced |
| there are no NAT gateways | pass, `describe-nat-gateways` returns none for the VPC and none in the account |
| the EventBridge rule targets a queue that has a DLQ | pass, `maxReceiveCount` 3 |
| the pharmacy check method requires AWS_IAM | fails on `assert.notEqual(method.apiKeyRequired, undefined)` |

The `authorizationType: AWS_IAM` part of that last test passes. The failure is
the line after it, `conformance/c.test.mjs:69`. floci never returns
`apiKeyRequired` from `GetMethod`, so no change inside `infra/c` can satisfy it.
Reported rather than worked around.

Also verified by hand: an event published to the `orders` bus with source
`retail` arrives on `OrderEventsQueue` with its detail intact.
