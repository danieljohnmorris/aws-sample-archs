# floci-three-ways

Three ways to wire the same two services on AWS, all running locally on [floci](https://github.com/floci-io/floci).

Two articles go with this repo. Part one, [floci: which parts of AWS run locally for real](https://danieljohnmorris.com/writing/floci-local-aws-what-runs-for-real/), is the emulator. Part two, [three ways to wire two services on AWS](https://danieljohnmorris.com/writing/three-ways-to-wire-two-services-on-aws/), is the comparison. This repo holds the code both describe.

Two services, `retail` and `pharmacy`. One scenario: a customer orders a prescription-only item, retail asks pharmacy to confirm a current prescription, pharmacy answers, retail fulfils or rejects. Same end-to-end test against each architecture.

- **A. Perimeter and addresses.** Two VPCs, NAT gateways, WAF IP allowlists, API Gateway. Callers identified by NAT gateway public IP.
- **B. Queues between VPCs.** Same two VPCs, no direct calls. SQS outside both, dead-letter queues, redrive.
- **C. Identity over addresses.** Callers are IAM roles. Security groups reference security groups. VPC endpoints replace NAT. EventBridge for async.

## Layout

```
apps/retail/        Node, runs as Lambda handler and as a container
apps/pharmacy/      Node, same
infra/a/            CDK, perimeter and addresses
infra/b/            CDK, queues between VPCs
infra/c/            CDK, identity over addresses
conformance/        SDK tests that read config back from floci and assert invariants
e2e/                One scenario test, runs against any of the three
docker-compose.yml  floci plus a profile per architecture
```

The service contract is in [CONTRACT.md](CONTRACT.md). What floci does and does not enforce is in [docs/day-one-floci-checks.md](docs/day-one-floci-checks.md). Read the contract before changing an app or a stack.

## Requirements

- Node 22 or newer. The apps are plain ESM JavaScript, no TypeScript and no build step.
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
make deploy ARCH=a             # build images, then cdk deploy --all
make e2e ARCH=a                # the scenario against the deployed stacks
make conformance ARCH=a        # read the config back and assert
make down ARCH=a
```

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

Without `DATABASE_URL` the suites that need it skip and print the `docker run` line above. The allowlist and proxy event mapping suites need no database and always run.

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
