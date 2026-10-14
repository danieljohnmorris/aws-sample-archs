# floci-three-ways

Three ways to wire the same two services on AWS, all running locally on [floci](https://github.com/floci-io/floci).

Two articles go with this repo. Part one, [floci: which parts of AWS run locally for real](https://danieljohnmorris.com/writing/floci-local-aws-what-runs-for-real/), is the emulator. Part two, [three ways to wire two services on AWS](https://danieljohnmorris.com/writing/three-ways-to-wire-two-services-on-aws/), is the comparison. This repo holds the code both describe.

Two services, `retail` and `pharmacy`. One scenario: a customer orders a prescription-only item, retail asks pharmacy to confirm a current prescription, pharmacy answers, retail fulfils or rejects. Same end-to-end test against each architecture.

- **A. Perimeter and addresses.** Two VPCs, NAT gateways, WAF IP allowlists, API Gateway. Callers identified by NAT gateway public IP.
- **B. Queues between VPCs.** Same two VPCs, no direct calls. SQS outside both, dead-letter queues, redrive.
- **C. Identity over addresses.** Callers are IAM roles. Security groups reference security groups. VPC endpoints replace NAT. EventBridge for async.

Then two simpler baselines, the ones most teams start from before they need A, B or C:

- **Simplified · one VPC.** Two services in one VPC. Retail calls pharmacy over plain HTTP through an internal ALB. Security groups are the only control between them. One NAT gateway.
- **Simplified · monolith.** One app, one database. The prescription check is a function call.

## Layout

```
apps/retail/        Node, runs as Lambda handler and as a container
apps/pharmacy/      Node, same
infra/a/            CDK, perimeter and addresses
infra/b/            CDK, queues between VPCs
infra/c/            CDK, identity over addresses
apps/monolith/      Node, retail and pharmacy in one Hono app
infra/simple-vpc/   CDK, Simplified one VPC
infra/monolith/     CDK, Simplified monolith
conformance/        SDK tests that read config back from floci and assert invariants
e2e/                One scenario test, runs against any of the five
docker-compose.yml  floci plus a profile per architecture
```

Each service is one [Hono](https://hono.dev) app object. `hono/aws-lambda` serves it as a Lambda handler and `@hono/node-server` serves it in a container, so the routes, the allowlist, the correlation id and the request log are written once and run the same in both. The three architectures put the same app behind API Gateway and behind an ALB, and only the entrypoint changes.

The service contract is in [CONTRACT.md](CONTRACT.md). What floci does and does not enforce is in [docs/day-one-floci-checks.md](docs/day-one-floci-checks.md). Read the contract before changing an app or a stack.

## Requirements

- Node 22 or newer. The apps are plain ESM JavaScript on Hono, no TypeScript and no build step.
- Docker, for floci and for the Postgres the tests use.
- AWS CLI v2 and CDK CLI 2.1139.0 or newer, for the stacks.

## Install

Each directory carries its own dependencies. There is no workspace, because the Lambda assets are the app directories zipped whole and they have to stand alone.

```sh
make deps                      # apps/retail and apps/pharmacy, production only
(cd e2e && npm install)
(cd conformance && npm install)
```

`make deploy` runs `make deps` first, so `node_modules` is on disk when CDK zips the asset. The AWS SDK stays in `dependencies` rather than relying on the copy bundled with the Lambda runtime.

## Running

One floci per architecture, so the three do not collide. Ports and project names come from `infra/<arch>/.env`.

```sh
make up ARCH=a                 # start floci for architecture A
make bootstrap ARCH=a          # once per architecture
make deploy ARCH=a             # deps, images, cdk deploy --all, outputs.json
make e2e ARCH=a                # the scenario against the deployed stacks
make conformance ARCH=a        # read the config back and assert
make down ARCH=a
```

floci cannot update a CloudFormation stack, so `make deploy` works once per fresh instance. To pick up a code change, replace the two app stacks and leave the base stacks, and their databases, alone:

```sh
make destroy-apps ARCH=a       # cdk destroy --exclusively RetailApp PharmacyApp
make deploy-apps ARCH=a        # cdk deploy --exclusively PharmacyApp RetailApp, then rebuild outputs.json
```

Architecture C also needs `aws iam delete-user --user-name ftw-c-retail-svc` between the two, after removing its key and policy, because floci leaves the user behind. `scripts/outputs.sh <arch>` rebuilds `outputs.json` from every deployed stack at any time.

Either service also runs on its own:

```sh
cd apps/pharmacy
DATABASE_URL=postgres://postgres:pw@localhost:55432/pharmacy node src/server.mjs
```

## Testing

### Postgres

Both the unit tests and the local end-to-end run need a real Postgres. One container serves all of them.

```sh
docker run -d --name ftw-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine
export DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres
```

The tests create the databases they need and never touch the one in the URL. Stop it with `docker rm -f ftw-test-pg`.

### Unit tests

```sh
make unit                      # both services
cd apps/retail && node --test   # one service
```

They cover every route, the allowlist accepting and rejecting, the webhook signature good and bad, the prescription validity rules, the proxy event mapping for both API Gateway payload versions, and double delivery through the consumers.

Each test file gets its own database, because `node --test` runs files in parallel and shared tables would be truncated underneath each other.

Without `DATABASE_URL` the suites that need it skip and print the `docker run` line above. The allowlist suite and the payload version checks in the proxy event mapping suite need no database and always run. The rest of that suite calls `handler` for real, so it needs one.

### End-to-end

```sh
make e2e ARCH=local            # both servers in one process, no floci
make e2e ARCH=a                # against the deployed stacks
```

`ARCH=local` starts retail on 3001 and pharmacy on 3002 against two databases on the local Postgres, wired the way architecture A is wired: synchronous HTTP, `PHARMACY_BASE_URL=http://localhost:3002`. Step 7 reads CloudWatch Logs, so it skips there.

The ports are fixed. A clash is reported rather than worked around.

`ARCH=a|b|c` reads the base URLs from `infra/<arch>/outputs.json` and the AWS settings from `infra/<arch>/.env`. Steps 3 and 4 poll for up to 30 seconds, because architecture B answers on a queue. `PAYMENT_WEBHOOK_SECRET` has to be in `infra/<arch>/.env` for step 6.

### Conformance

```sh
make conformance ARCH=a
```

One file per architecture. Each reads the deployed configuration back through the SDK and asserts what CONTRACT.md says for that architecture. A file skips when `ARCH` names a different architecture, and when `infra/<arch>/outputs.json` is missing.

## Stack outputs the tests read

The tests find everything through CloudFormation outputs. Keys are flattened across the stacks in an architecture, so no two stacks may use the same key.

| Key | Used by | Meaning |
|---|---|---|
| `RetailApiUrl` | e2e, all | Base URL of the retail API |
| `PharmacyApiUrl` | e2e, all | Base URL of the pharmacy API |
| `RetailLogGroup` | e2e, a and c | CloudWatch log group for the retail Lambda, step 7 |
| `PharmacyWebAclArn` | conformance a | Web ACL in front of the pharmacy API |
| `PharmacyIpSetArn` | conformance a | IP set the Web ACL allows |
| `RetailNatEip` | conformance a | Retail NAT gateway public IP, without a prefix |
| `RetailDbSgId` | conformance a | Security group on the retail database |
| `RetailAppSgId` | conformance a | Security group on the retail application |
| `CheckRequestQueueUrl` | conformance b | Queue retail sends check requests to |
| `CheckResultQueueUrl` | conformance b | Queue pharmacy sends answers to |
| `VpcId` | conformance b and c | VPC the security group checks are scoped to |
| `RetailRoleArn` | conformance b, optional | Role the queue policies should name |
| `PharmacyRoleArn` | conformance b, optional | Role the queue policies should name |
| `PharmacyRestApiId` | conformance c | REST API id for the AWS_IAM method check |
| `EventRuleName` | conformance c | EventBridge rule carrying order events |
| `EventBusName` | conformance c | Bus the rule sits on |

`RetailRoleArn` and `PharmacyRoleArn` are optional. Without them the queue policy check asserts every principal is a named IAM role rather than a wildcard, instead of matching exact ARNs.

## Environment

CONTRACT.md holds the full table. Two things worth repeating here.

Region is read from `AWS_REGION`, falling back to `AWS_DEFAULT_REGION`. Nothing in `apps/`, `e2e/` or `conformance/` names a region. The e2e and conformance loaders copy `AWS_DEFAULT_REGION` into `AWS_REGION` when only the first is set, because the SDK v3 environment provider reads the second name only.

Mode selection in retail is one variable. `CHECK_REQUEST_QUEUE_URL` set means queues, architecture B. Unset means HTTP to `PHARMACY_BASE_URL`, architecture A, or C when `SIGN_REQUESTS=true` adds SigV4 signing for `execute-api`.

## Where the apps go past CONTRACT.md

Three additions, none of them contradicting it.

The request object carries two fields beyond the five the contract lists. `rawBody` holds the bytes as they arrived, which the payment webhook needs, since the signature covers the raw body and not a re-serialised object. `query` holds the parsed query string, which the pharmacy check route needs. Both entrypoints fill in both.

Pharmacy has a `processed_messages` table as well as `prescriptions`. The contract only lists it under retail, but architecture B makes pharmacy an SQS consumer and the contract requires consumers to dedupe on `idempotencyKey`.

Pharmacy depends on `@aws-sdk/client-sqs`, for the same reason. It reads the request queue and writes to the result queue.

## Architecture A: perimeter and addresses

Four stacks, in `infra/a/`. `RetailBase` and `PharmacyBase` hold one VPC each with
public, private-with-egress and isolated tiers across two zones, one NAT gateway
on a retained elastic IP, a Postgres 16 `db.t3.micro` in the isolated tier that
only the application security group can reach on 5432, and a log group. Both
carry termination protection and retain the database on delete. `RetailApp` runs
retail on Lambda behind a REST API. `PharmacyApp` runs pharmacy on Fargate behind
an internal ALB and an HTTP API.

The split is deliberate. In this architecture a caller is identified by the
public address its traffic leaves from, so that address has to outlive the
application. The elastic IP is allocated in the base stack, and destroying and
redeploying an app stack leaves the other side's allowlist correct. That was
tested: both NAT addresses came back unchanged, and the rows written before the
teardown were still in the database afterwards.

Nothing crosses between stacks through a CloudFormation export. Base stacks
publish VPC id, subnet ids, security group ids, the NAT address, the database
endpoint and the secret ARN to SSM, and app stacks read them back through
template parameters CloudFormation resolves at deploy time. An export in use
cannot be changed, which would freeze the base stacks while the app stacks are
up.

Each side blocks the other's absence at three layers: a REGIONAL Web ACL on the
API stage that blocks by default and allows one IP set, an API Gateway resource
policy keyed on `aws:SourceIp` for retail, and `ALLOWED_CIDRS` inside the
application. All three name the same addresses. Only the third one can be watched
rejecting a request under floci.

```sh
make up ARCH=a
make bootstrap ARCH=a
make deploy ARCH=a
make e2e ARCH=a
make conformance ARCH=a
```

`infra/a/.env` carries two values the stacks read, `DB_PASSWORD` and
`PAYMENT_WEBHOOK_SECRET`. Both are fixtures for a throwaway emulator, and both
exist because floci hands a Lambda or a task the literal
`{{resolve:secretsmanager:…}}` string rather than the value behind it. Neither is
set on AWS, where the stacks generate the values and pass the reference.

Two switches change the shape of the output for a real deployment. `WAF_SDK_SHIM=off`
replaces the custom resource that builds the IP set with the plain
`AWS::WAFv2::IPSet` and `AWS::WAFv2::WebACLAssociation` resources, which floci
accepts and does not act on. Clearing `ALB_INTEGRATION_HOST` points the HTTP API
integration at the load balancer's DNS name instead of at floci.

`infra/a/NOTES.md` records what was run, how long each deploy took, what survived
the teardown, and fourteen places floci behaves differently from AWS.

## Architecture B: queues between VPCs

Two VPCs with zero NAT gateways, so neither side has a route out. Retail puts a
`PrescriptionCheckRequested` on `ftw-b-check-request`; a Fargate worker in the
pharmacy VPC, with no load balancer and no inbound listener, reads it and
answers on `ftw-b-check-result`; a second retail Lambda applies the result
through an SQS event source mapping. `POST /orders` returns `PENDING` and the
scenario polls. Both queues redrive to a dead letter queue at `maxReceiveCount`
3, and redrive back is a manual `aws sqs start-message-move-task`.

Five stacks. `RetailBase` and `PharmacyBase` hold a VPC each, the SQS, Secrets
Manager and CloudWatch Logs interface endpoints, Postgres 16 in isolated
subnets and a log group at 30 days, with termination protection on and RETAIN
on the database. `Messaging` holds the queues, the KMS key, the two service
roles and the two service users, outside both VPCs because SQS is regional.
`RetailApp` and `PharmacyApp` hold everything that gets replaced.

Nothing crosses a stack boundary as a CloudFormation export. The base stacks
publish their ids as SSM parameters and the app stacks read them through
`AWS::SSM::Parameter::Value<String>`, so destroying an app stack leaves the
base untouched.

```
make up ARCH=b
make bootstrap ARCH=b
make deploy ARCH=b
make e2e ARCH=b
make conformance ARCH=b
```

`make deploy ARCH=b` runs once against a given floci. floci cannot create a
read-only change set, so the CDK CLI issues an update on every stack it is
asked about, and floci's update path re-creates Secrets Manager secrets and
fails on the name. To change an app stack, destroy it and deploy it again with
`--exclusively`. `infra/b/NOTES.md` has the commands, the timings, the IAM
denials with their exact responses, and the rest of what floci does and does
not do here.

Identity is the part floci can actually enforce. This instance runs with
`FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true`, so `retail-svc` sends to
`ftw-b-check-request` and gets `AccessDeniedException` on `sqs:ReceiveMessage`,
while `pharmacy-svc` consumes and replies. Queue policies name only the two
role ARNs and are readable, but floci does not gate on them.

## Architecture C: identity over addresses

`infra/c/` is a CDK app in TypeScript, four stacks. `SharedBase` holds the VPC,
the security groups and the two databases, and carries termination protection.
`Events` holds the `orders` bus and the audit queue. `PharmacyApp` and
`RetailApp` are the two that get destroyed and redeployed. Destroying both
leaves the VPC, both security-group sets, both Postgres instances, the bus and
all three queues in place.

The VPC has no NAT gateways, no internet gateway and no route to `0.0.0.0/0`.
Traffic to AWS goes through six interface endpoints and the S3 gateway
endpoint. Every ingress rule names a security group; none names a CIDR. The
retail Lambda has one identity, `ftw-c-retail-lambda`, and that role ARN is the
only principal the pharmacy API's resource policy allows.

Two things about running it on floci, both written up in
[infra/c/NOTES.md](infra/c/NOTES.md).

floci's CloudFormation cannot update a stack. `make deploy ARCH=c` works once on
a fresh floci. After that, replace the app stacks with
`cdk destroy --exclusively RetailApp PharmacyApp` and
`cdk deploy --exclusively PharmacyApp RetailApp`, which is what keeps CDK from
re-submitting `SharedBase` as a dependency. Delete the IAM user
`ftw-c-retail-svc` in between, because floci does not remove it with the stack.

`infra/c/.env` carries `DB_PASSWORD` and `PAYMENT_WEBHOOK_SECRET`. floci does
not resolve `{{resolve:secretsmanager:...}}`, so a generated secret reaches the
Lambda as literal placeholder text and every database connection and signature
check fails. The stacks read both values at synth and still write them to
Secrets Manager.

## Simplified: one VPC, then a monolith

A, B and C each add something on top of a plainer design. These two are that plainer design, built and tested the same way, so the comparison has a baseline.

### Simplified · one VPC

Three stacks, in `infra/simple-vpc/`, prefix `ftw-sv`. `SharedBase` holds one VPC (`10.70.0.0/16`) with public, private-with-egress and isolated tiers, one NAT gateway, five security groups and two Postgres 16 instances. `PharmacyApp` runs pharmacy on Fargate behind an internal ALB on port 8110. `RetailApp` runs retail on Lambda behind the customer REST API and the same managed-rules Web ACL as C.

Retail calls `http://<alb dns name>:8110/prescriptions/:id/check` with no signature. `PHARMACY_BASE_URL` is the only wiring, and the apps are unchanged from A. What stops anything else calling pharmacy is one ingress rule: the pharmacy ALB group admits the retail app group and nothing else.

Against C, this drops the pharmacy API Gateway, `AWS_IAM`, SigV4, the EventBridge bus and the seven VPC endpoints, and adds one NAT gateway. Against A, it drops the second VPC, the public hop between services and every IP allowlist.

floci's embedded DNS answers the ALB name for containers floci starts, and the retail Lambda is one of them, so no floci-only API sits in the path here. Tests reach pharmacy on `http://localhost:8110`, because floci publishes the listener on the host.

### Simplified · monolith

Two stacks, in `infra/monolith/`, prefix `ftw-mono`. `Base` holds a VPC (`10.80.0.0/16`) with isolated subnets only, no NAT and no internet gateway, two security groups and one Postgres instance. `App` runs `apps/monolith` on Lambda behind one REST API with the same Web ACL.

`apps/monolith` serves the retail and pharmacy routes on one URL with one `/health`. `POST /orders` calls `checkPrescription()` directly, so the order comes back decided in the same request. Orders and prescriptions are two tables in one database. The boundary between the halves is now module discipline, not the network: retail code can read prescription rows.

```sh
make up ARCH=simple-vpc        # or ARCH=monolith
make bootstrap ARCH=simple-vpc
make deploy ARCH=simple-vpc
make e2e ARCH=simple-vpc
make conformance ARCH=simple-vpc
make e2e ARCH=monolith-local   # the monolith in-process against the test Postgres, no floci
```

### Measured side by side

All five deployed on fresh floci instances on 2026-10-14, one after another on the same Mac. `floci/floci:latest` image `4e451c39c7bb`, CDK CLI 2.1139.0. Each passed `make e2e` (7 of 7) and `make conformance` on that run.

| | A | B | C | One VPC | Monolith |
|---|---|---|---|---|---|
| Stacks | 4 | 5 | 4 | 3 | 2 |
| CloudFormation resources (`cdk synth`) | 142 | 139 | 114 | 67 | 31 |
| CDK TypeScript lines (`bin/` + `lib/`) | 1,116 | 954 | 1,030 | 390 | 252 |
| VPCs | 2 | 2 | 1 | 1 | 1 |
| NAT gateways | 2 | 0 | 0 | 1 | 0 |
| Elastic IPs | 2 | 0 | 0 | 1 | 0 |
| VPC endpoints | 0 | 6 | 7 | 0 | 0 |
| Postgres instances | 2 | 2 | 2 | 2 | 1 |
| SQS queues | 0 | 4 | 3 | 0 | 0 |
| `make deploy`, wall clock | 51s | 57s | 35s | 34s | 32s |
| `cdk deploy --all`, CDK total | 26.6s | 37.5s | 16.7s | 15.0s | 13.6s |

Resource and line counts come from the templates and files in this repo. VPC endpoint counts come from the templates. NAT, EIP, VPC, Postgres and queue counts were read back from floci after the deploy with `scripts/measure-live.sh`. Wall clock includes `make deps` and `make images`, with the npm cache and Docker layers warm. floci is not AWS, so the times say how much CDK and CloudFormation work each design is, not how long AWS would take.
