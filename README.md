# floci-three-ways

Three ways to wire the same two services on AWS, all running locally on [floci](https://github.com/floci-io/floci).

The write-up is at [danieljohnmorris.com/writing/three-aws-architectures-one-emulator](https://danieljohnmorris.com/writing/three-aws-architectures-one-emulator/). This repo holds the code the article describes.

Two services, `retail` and `pharmacy`. One scenario: a customer orders a prescription-only item, retail asks pharmacy to confirm a current prescription, pharmacy answers, retail fulfils or rejects. Same end-to-end test against each architecture.

- **A. Perimeter and addresses.** Two VPCs, NAT gateways, WAF IP allowlists, API Gateway. Callers identified by NAT gateway public IP.
- **B. Queues between VPCs.** Same two VPCs, no direct calls. SQS outside both, dead-letter queues, redrive.
- **C. Identity over addresses.** Callers are IAM roles. Security groups reference security groups. VPC endpoints replace NAT. EventBridge for async.

## Layout

```
apps/retail/        Node, runs as Lambda handler and as a container
apps/pharmacy/      Node, same
infra/a-perimeter/  CDK
infra/b-queues/     CDK
infra/c-identity/   CDK
conformance/        SDK tests that read config back from floci and assert invariants
e2e/                One scenario test, runs against any of the three
docker-compose.yml  floci plus a profile per architecture
```

## Status

Nothing built yet. Repo created ahead of the article so the links resolve.
