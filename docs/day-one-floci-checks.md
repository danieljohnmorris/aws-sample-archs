# Day one: what floci does and does not do

Run on 2026-09-03 against `floci/floci:latest`, digest `sha256:4e451c39…`, image created 2026-09-01 (v2.0.1). Docker Desktop 29.6.1 on macOS, AWS CLI 2.27.40, CDK CLI 2.1139.0, aws-cdk-lib 2.268.0. Region `eu-west-1`, account `000000000000`, credentials `test`/`test`.

Everything below was observed, not read from docs. Throwaway commands, not kept.

## Works

| Check | Result |
|---|---|
| Lambda `nodejs22.x` create + invoke | Container from `public.ecr.aws/lambda/nodejs:22`, 200, handler output returned |
| Lambda stdout to CloudWatch Logs | `/aws/lambda/<name>` log group created automatically, `filter-log-events` returns the `console.log` line |
| Lambda reaching an ECS task by container IP | 200 |
| Lambda reaching the ALB by `floci:8080` and by its DNS name `d1-alb-….elb.floci:8080` | 200 both. floci's embedded DNS answers the ALB name with floci's own IP |
| Lambda reaching an HTTP API by `<id>.execute-api.localhost.floci.io:4566` | 200 |
| ECS Fargate task, `awsvpc`, nginx | Real container on `floci-three-ways_default`, `RUNNING` in a few seconds |
| ALB, `ip` target group, HTTP listener on 8080 | Forwards to the task container. Reachable from host at `localhost:8080` and in-network at `floci:8080` |
| HTTP API (v2) `HTTP_PROXY` integration to the ALB | 200 via `<id>.execute-api.localhost.floci.io:4566/<route>` |
| RDS Postgres 16 | `available` in about a minute, endpoint `localhost:7001`, `psql` connects |
| SQS DLQ with `maxReceiveCount` 2 | Poison message lands in DLQ after two receives |
| SQS `start-message-move-task` | Message moved back from DLQ to source queue |
| EventBridge custom bus, rule, SQS target | Event delivered to the queue |
| EventBridge `create-archive` / `start-replay` | Archive `ENABLED`, replay `RUNNING`. Delivery of replayed events not tested |
| VPC, subnet, EIP, NAT gateway, SG-to-SG ingress | All created and read back. NAT gateway `available` immediately |
| WAF v2 IP set, Web ACL default-block, associate to API stage | Created, association readable via `get-web-acl-for-resource` |
| `cdk bootstrap` | `CDKToolkit` stack completes |
| `cdk deploy` of VPC (3 subnet tiers, 1 NAT) + SQS + WAF IP set + Web ACL | `CREATE_COMPLETE`, 32 resources, 2 seconds. Needs CDK CLI 2.1139.0 or newer for aws-cdk-lib 2.268.0 |

## Does not enforce

| Check | Result |
|---|---|
| WAF Web ACL (default block, allow one IP) associated to an API stage | Requests still 200. Docs say floci stores WAF config and does not filter traffic |
| API Gateway REST method with `authorizationType: AWS_IAM` | Unsigned request 200. Same with IAM enforcement mode on |
| API Gateway resource policy denying all but one `aws:SourceIp` | 200 after redeploy |
| SQS queue policy with `Deny` on `sqs:SendMessage` for `*` | Send succeeds |
| Security group source CIDR | Not tested for enforcement; docs say the CIDR value is not enforced |
| Client source IP seen by Lambda through API Gateway | `127.0.0.1`. Docker port mapping hides the caller |

## IAM enforcement mode

`FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true`. The `test` key and unknown keys bypass it; real IAM users and assumed roles are evaluated.

| Check | Result |
|---|---|
| User with `sqs:SendMessage` on `Resource: "*"` sends | 200 |
| Same user with `Resource: arn:aws:sqs:eu-west-1:000000000000:retail-q` (the exact ARN floci reports) | `AccessDeniedException`, also with `arn:aws:sqs:*:*:retail-q` |
| User without `sqs:ReceiveMessage` receives | `AccessDeniedException` |
| User without `sqs:ListQueues` lists | `AccessDeniedException` |
| Assumed role with `ReceiveMessage` on the exact queue ARN | `AccessDeniedException` |
| Queue policy `Deny` (resource-based) under enforcement | Still allowed |

Cause, from floci's own log line:

```
IamEnforcementFilter IAM enforcement DENY: akid=AKIA… action=sqs:SendMessage resource=arn:aws:sqs:eu-west-1:000000000000:*
```

The filter resolves every SQS request (JSON protocol, as AWS CLI v2 and SDK v3 send it) to the wildcard queue ARN, so a policy naming a queue never matches and `Resource: "arn:aws:sqs:eu-west-1:000000000000:*"` or `"*"` is the narrowest allow that works. `ResourceArnBuilder.buildSqsArn` in the floci source reads `QueueUrl` from query, form or JSON body and falls back to `*`; on this build the JSON path is not reached. So enforcement is action-level for SQS. The filter's Javadoc also says resource-based policies are not supplied to it.

## Not working

| Check | Result |
|---|---|
| Cloud Map private DNS namespace + A record | `create-service` and `register-instance` succeed. `api.pharmacy.local` does not resolve from a container or from Lambda (`ENOTFOUND`) |
| `describe-tasks` network interface | `attachments: null`, no `privateIpv4Address`. Container IP only visible via `docker inspect` |

## Consequences for the three builds

- A: WAF and API Gateway allowlists deploy but cannot be seen rejecting anything. The only observable allowlist is the one in the app. Conformance tests read the config back instead.
- B: queue policies deploy but do not gate. IAM enforcement mode with per-service users and action-scoped policies is the observable version.
- C: `AWS_IAM` on API Gateway deploys but does not gate. Service discovery uses the ALB DNS name or an HTTP API, since Cloud Map DNS does not answer.
