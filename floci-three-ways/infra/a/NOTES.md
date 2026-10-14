# Architecture A on floci: what was run and what happened

Everything below was run on 2026-09-03 against `floci/floci:latest`, image digest
`sha256:4e451c39…`, on Docker Desktop 29.6.1 on macOS. Region `eu-west-2`,
account `000000000000`, CDK CLI 2.1139.0, aws-cdk-lib 2.268.0. Only observed
results are recorded. Where a number is quoted it came off the terminal.

## The stacks

Four, deployed in dependency order.

| Stack | Holds |
|---|---|
| `RetailBase` | VPC `10.10.0.0/16`, three subnet tiers across two zones, one NAT gateway on a retained elastic IP, Postgres 16 `db.t3.micro` in the isolated tier, the application and database security groups, the log group, the database secret |
| `PharmacyBase` | The same for `10.20.0.0/16` |
| `PharmacyApp` | Fargate service, internal ALB on 8080, HTTP API, Web ACL |
| `RetailApp` | Lambda, REST API with a resource policy, Web ACL |

Nothing crosses between them through a CloudFormation export. Base stacks publish
to SSM under `/ftw-a/<service>/…` and app stacks read those back through
`AWS::SSM::Parameter::Value<String>` template parameters, which CloudFormation
resolves at deploy time. A cold `cdk deploy --all` therefore works in one pass.

The elastic IP is allocated in the base stack, not the app stack. In this
architecture the address **is** the identity: pharmacy decides whether to answer
retail by looking at where retail's traffic left from. If the address moved every
time an app stack was replaced, the other side's allowlist would be wrong after
every deploy. `RemovalPolicy.RETAIN` on the EIP and `terminationProtection` on
both base stacks are what hold that still.

## Timings

Wall clock for the whole command, and the figure CDK printed for itself.

| Command | Wall | CDK reported |
|---|---|---|
| `make up ARCH=a` | 6s | |
| `make bootstrap ARCH=a` | 25s | |
| `make deploy ARCH=a`, cold, images already built | 34s | 24.51s |
| `make deploy ARCH=a`, cold, first image build and asset publish | 157s | 132.37s |
| `cdk destroy RetailApp PharmacyApp --exclusively --force` | 112s | |
| `cdk deploy PharmacyApp RetailApp --exclusively` | 93s | 13.25s |

Most of the gap between wall clock and the CDK figure is `npx aws-cdk@2.1139.0`
fetching the CLI, which the Makefile does on every target.

## Destroy and redeploy

Ran, exactly:

```
cd infra/a && npx aws-cdk@2.1139.0 destroy RetailApp PharmacyApp --exclusively --force
```

`--exclusively` matters. Without it CDK pulls in the stacks the named ones depend
on, and given the update behaviour below that is not something to do by accident.
`make destroy ARCH=a` runs `--all`, which would take the base stacks too.

floci reported `RetailApp: destroyed` and `PharmacyApp: destroyed`, rc 0.

Survived, checked through the SDK afterwards:

| Thing | Before | After |
|---|---|---|
| `RetailBase`, `PharmacyBase` | `CREATE_COMPLETE` | `CREATE_COMPLETE` |
| `ftw-a-retail` database | `available`, `localhost:7001` | `available`, `localhost:7001` |
| `ftw-a-pharmacy` database | `available`, `localhost:7002` | `available`, `localhost:7002` |
| Rows in `orders` | 3 | 3 |
| Retail NAT EIP | `54.179.117.169` | `54.179.117.169` |
| Pharmacy NAT EIP | `54.199.94.65` | `54.199.94.65` |
| NAT gateways | 2 | 2 |
| Database secrets | 2 | 2 |
| `/aws/lambda/ftw-a-retail`, retention 30 | present | present |
| SSM parameters | 26 | 23 |

Went, as intended: both Lambdas and the shim, the ECS cluster, the webhook
secret, both WAF IP sets, and the three SSM parameters the app stacks own.

Redeploying the two app stacks put them back on the same base. Both NAT
addresses came back unchanged in `outputs.json`, the retail allowlist was rebuilt
holding `54.199.94.65/32` and the pharmacy allowlist holding `54.179.117.169/32`,
and the three orders written before the destroy were still in the database.
`make e2e ARCH=a` and `make conformance ARCH=a` were green before the destroy and
green again after the redeploy: 7 of 7 and 22 of 22.

## Where floci differs from AWS

Fourteen things, all measured here. The first four cost real time.

### CloudFormation treats every update as a teardown

`create-change-set` against a stack with `--use-previous-template`, so an
identical template, reported **46 changes, every one `Action: Remove`**. Running
`cdk deploy` a second time over an unchanged `RetailBase` therefore tried to
delete and rebuild it. Fixed names collided first:

```
RetailBase | UPDATE_FAILED | AWS::SecretsManager::Secret | A secret with the name ftw-a/retail/db already exists.
RetailBase | UPDATE_FAILED | AWS::EC2::EIP | Rollback is not implemented for AWS::EC2::EIP
RetailBase | UPDATE_FAILED | AWS::EC2::VPC | Rollback is not implemented for AWS::EC2::VPC
```

and the stack finished in `UPDATE_ROLLBACK_FAILED`. `cdk diff` had said "There
were no differences" for the same template a minute earlier.

Treat a floci stack as create-only. To change something, destroy the stack and
deploy it, or reset floci. This is the reason each measured run below starts from
`make down ARCH=a && make up ARCH=a`.

`cdk diff` also cannot create its own read-only change set and falls back to a
template diff, so it never reports replacement information.

### A Lambda or task environment variable does not resolve a dynamic reference

`{{resolve:secretsmanager:<arn>:SecretString:password}}` in an
`AWS::Lambda::Function` environment variable arrives at the function as that
literal string. Same for an `AWS::ECS::TaskDefinition` container environment. The
retail Lambda logged:

```
"error":"Invalid URL","stack":"TypeError: Invalid URL
    at parse (/var/task/node_modules/pg-connection-string/index.js:30:16)"
```

because `DATABASE_URL` held `postgresql://postgres:{{resolve:…}}@floci:7002/retail`.

The same reference **does** resolve for `AWS::RDS::DBInstance.MasterUserPassword`.
Connecting to the instance with the generated password from Secrets Manager
worked; connecting with the literal `{{resolve:…}}` string was rejected. So this
is per property, not a blanket gap.

Worked around by reading the password and the webhook key from `infra/a/.env` and
inlining them, which also gives the end-to-end test a key it can sign with. Both
base stacks and both app stacks read the same two variables, so a base stack
deployed on Monday and an app stack redeployed on Tuesday still agree. On AWS
neither variable is set and the dynamic reference is used.

### WAF resources built through CloudFormation are not real

`AWS::WAFv2::IPSet` reports `CREATE_COMPLETE` and creates nothing. `Fn::GetAtt`
on it returns `arn:aws:stub:::PerimeterIpSet1D5B0A04`, which is the logical id,
identical in both stacks. `ListIPSets` stayed empty. The Web ACL that referenced
that stub came back from `GetWebACL` with

```json
{ "IPSetReferenceStatement": {} }
```

`AWS::WAFv2::WebACLAssociation` behaved the same way: `GetWebACLForResource` on
the stage returned nothing.

`AWS::WAFv2::WebACL` itself is fine. It gets a real ARN and `DefaultAction` reads
back as `Block`.

Every one of those operations works through the SDK. `CreateIPSet`,
`CreateWebACL` with a populated `IPSetReferenceStatement`, `AssociateWebACL` and
`GetWebACLForResource` all returned correct values, and floci enforces WAF lock
tokens properly: `DeleteIPSet` and `UpdateIPSet` with a made-up `LockToken` both
returned `WAFOptimisticLockException`.

So `waf-shim/index.mjs` is a CloudFormation custom resource that does those calls
through the SDK, and the conformance suite can read the perimeter back. Custom
resources work: a probe Lambda answered on the presigned response URL and
`Fn::GetAtt` on the custom resource resolved. `WAF_SDK_SHIM=off` emits the plain
`AWS::WAFv2::IPSet` and `AWS::WAFv2::WebACLAssociation` instead, which is what
should go to AWS.

### floci does not resolve its own DNS names for itself

floci runs an embedded resolver on its container address and hands it to
containers it launches, through `HostConfig.Dns`. From the pharmacy task,
`ftw-a-pharmacy-….elb.floci` resolved to floci's address. From floci's own
container it did not resolve at all, and neither did it from a plain
`docker run` on the same network.

API Gateway `HTTP_PROXY` integrations are executed by floci, from that container.
An integration naming the load balancer's DNS name therefore returns 502:

```
WARN [io.git.hec.flo.ser.api.pro.HttpProxyInvoker] HTTP_PROXY backend call failed: null
```

The day-one note that floci resolves `<name>.elb.floci` from Lambda containers is
right as far as it goes. It does not extend to floci's own outbound calls.

floci publishes the load balancer listener on its own address, so pointing the
integration at `http://floci:8080` reaches the same listener and answers 200.
`ALB_INTEGRATION_HOST` sets it; unset it and the stack uses the load balancer
name, which is what AWS needs. On AWS this integration would need a VPC Link,
which floci does not, because there is one flat Docker network.

### The rest

| Check | Result |
|---|---|
| `AWS::SSM::Parameter::Value<List<String>>` | Does not resolve. `Fn::Select` over it returned the parameter *name*, `/spike/subnets`. The `<String>` form resolves correctly, and `Fn::Split` over it works, so subnet ids are published comma-joined |
| `AWS::SecretsManager::SecretTargetAttachment` | `CREATE_FAILED`, "DB instance ftw-a-retail not found", while `describe-db-instances` reported that instance `available`. CDK adds this resource whenever `Credentials.fromGeneratedSecret` is used, so the stack uses `Credentials.fromPassword` and an explicit secret |
| REST API v1 URL | Served at `http://localhost.floci.io:4566/restapis/<id>/<stage>/_user_request_`. The `<id>.execute-api.localhost.floci.io` form returns an S3 `NoSuchBucket` error, so floci matches the subdomain as a bucket before API Gateway sees it. HTTP API v2 does use the virtual host form |
| `*.localhost.floci.io` | Resolves to 127.0.0.1 in public DNS and to floci's address inside floci-launched containers, so one URL works from the host, from Lambda and from a task |
| ECS `logConfiguration` | `describe-task-definition` returned `null` for it. The declared awslogs group is dropped and floci creates `/ecs/<cluster>` instead. The group in the base stack is still the one with retention set |
| API Gateway resource policy | `get-rest-apis` returned `policy: None`. The policy is not stored, let alone applied |
| RDS `DeletionProtection` | Reported as `null` however the template is written. `StorageEncrypted: true` came back as `false`. `DeletionPolicy: Retain` is honoured, which is the part that matters here |
| ECS local image | `ftw-pharmacy:local` ran straight from the local Docker daemon through the mounted socket. Nothing had to be pushed to floci's ECR. The CDK bootstrap repository was created and left empty |
| Lambda environment | floci sets `AWS_REGION`, `AWS_DEFAULT_REGION` and `AWS_ENDPOINT_URL` itself. A task gets none of them, so the task definition sets all three. `AWS_REGION` is reserved on real Lambda, so it is not set there |
| Client IP through API Gateway | `127.0.0.1`, as the day-one notes said. Every allowlist here includes it for that reason, alongside `172.16.0.0/12` for the Docker network |
| WAF and resource policy enforcement | Neither filters traffic, as the day-one notes said. The only allowlist that can be watched rejecting a request is `ALLOWED_CIDRS` inside the application |

## Reproducing

```
make down ARCH=a && make up ARCH=a
make bootstrap ARCH=a
make deploy ARCH=a
make e2e ARCH=a
make conformance ARCH=a
```

To exercise the retained base:

```
cd infra/a && npx aws-cdk@2.1139.0 destroy RetailApp PharmacyApp --exclusively --force
cd infra/a && npx aws-cdk@2.1139.0 deploy PharmacyApp RetailApp --exclusively --require-approval never --outputs-file outputs.json
```

`infra/a/.env` holds `DB_PASSWORD` and `PAYMENT_WEBHOOK_SECRET`. Both are local
fixtures for a throwaway emulator. Neither is set on AWS, where the stacks
generate the values instead.
