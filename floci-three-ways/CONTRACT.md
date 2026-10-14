# Service contract

Shared by all three architectures. Apps are built once against this; each `infra/*` CDK app wires them differently. Change this file before changing an app or a stack.

## Services

Two Node 22 services, plain ESM JavaScript, Hono, no TypeScript build step. Each exports a Hono `app` from `apps/<svc>/src/app.mjs` and has two entrypoints:

- `apps/<svc>/src/lambda.mjs`: `handle(app)` from `hono/aws-lambda`, exported as `handler`, for REST v1 and HTTP API v2 payload 2.0 events; `sqsHandler` for queue records.
- `apps/<svc>/src/server.mjs`: `serve(app)` from `@hono/node-server` on `PORT` (default 8080).
- `apps/<svc>/Dockerfile`: `node:22-alpine`, runs `server.mjs`. Image tag `ftw-<svc>:local`, built by `make images`.

Handlers read the parsed body, query and raw body from the Hono context. Responses are JSON objects with the status codes listed below.

### retail

| Route | Purpose |
|---|---|
| `GET /health` | `{ ok: true, service: "retail" }` |
| `POST /orders` | Body `{ customerId, sku, quantity, prescriptionId? }`. Creates order `PENDING`. If SKU is prescription-only (`sku` starts with `RX-`), triggers a prescription check; else `FULFILLED` at once. Returns `{ orderId, status }`. |
| `GET /orders/:id` | `{ orderId, status, reason? }`. Status one of `PENDING`, `FULFILLED`, `REJECTED`. |
| `POST /internal/prescription-result` | B only. Body `{ orderId, valid, reason? }`. Applies a check result. |
| `POST /webhooks/payment` | Simulated third-party webhook. Checks `x-signature` HMAC-SHA256 of the raw body with `PAYMENT_WEBHOOK_SECRET`. Returns 401 on mismatch. Exists in all three so the third-party-inbound story can be compared. |

### pharmacy

| Route | Purpose |
|---|---|
| `GET /health` | `{ ok: true, service: "pharmacy" }` |
| `POST /prescriptions` | Body `{ prescriptionId, customerId, sku, expiresAt }`. Seeds a prescription. Used by tests. |
| `GET /prescriptions/:id/check?customerId=&sku=` | `{ valid: boolean, reason?: string }`. Valid when the prescription exists, belongs to the customer, covers the SKU and has not expired. |

### How retail asks pharmacy

| Arch | Mechanism |
|---|---|
| A | Synchronous HTTP `GET` to `PHARMACY_BASE_URL` + `/prescriptions/:id/check`. Retail applies the answer inline; `POST /orders` returns the final status. |
| B | Retail sends `PrescriptionCheckRequested` to `CHECK_REQUEST_QUEUE_URL`. Pharmacy consumer answers on `CHECK_RESULT_QUEUE_URL`. Retail consumer applies the result. `POST /orders` returns `PENDING`; tests poll `GET /orders/:id`. |
| C | Synchronous HTTP as in A, but the request is SigV4-signed with the caller's role and the pharmacy API is `AWS_IAM`. Order events also go to an EventBridge bus for audit. |

Message shapes (B and C events), all with `Detail`/body as JSON:

```json
{ "type": "PrescriptionCheckRequested", "orderId": "...", "prescriptionId": "...", "customerId": "...", "sku": "...", "idempotencyKey": "<orderId>" }
{ "type": "PrescriptionCheckCompleted", "orderId": "...", "valid": true, "reason": null, "idempotencyKey": "<orderId>" }
```

Consumers must dedupe on `idempotencyKey`.

## Allowlist middleware (A only, on by default there, off elsewhere)

`ALLOWED_CIDRS` comma-separated. When set, `handle` returns 403 `{ error: "forbidden", sourceIp }` for any `sourceIp` outside the list, except `/health`. This is the one allowlist layer floci lets us see rejecting a request.

## Storage

Each service owns one Postgres database. Schema is created by the app on first request if missing (`CREATE TABLE IF NOT EXISTS`). Connection from `DATABASE_URL`. Tables:

- retail: `orders(order_id text primary key, customer_id text, sku text, quantity int, prescription_id text, status text, reason text, created_at timestamptz)` and `processed_messages(idempotency_key text primary key, processed_at timestamptz)`.
- pharmacy: `prescriptions(prescription_id text primary key, customer_id text, sku text, expires_at timestamptz)`.

## Logging

Every request logs one JSON line to stdout: `{ ts, service, level, msg, method, path, status, ms, correlationId, sourceIp }`. `correlationId` comes from `x-correlation-id` inbound or is generated, and is forwarded on every outbound call and message.

## Environment variables

| Var | Who | Meaning |
|---|---|---|
| `PORT` | both (server mode) | listen port, default 8080 |
| `DATABASE_URL` | both | Postgres URL |
| `SERVICE_NAME` | both | `retail` or `pharmacy` |
| `ALLOWED_CIDRS` | both | see above |
| `PAYMENT_WEBHOOK_SECRET` | retail | HMAC secret |
| `PHARMACY_BASE_URL` | retail (A, C) | base URL of the pharmacy API |
| `SIGN_REQUESTS` | retail (C) | `true` to SigV4-sign outbound calls with `execute-api` service |
| `CHECK_REQUEST_QUEUE_URL` | retail (B send), pharmacy (B consume) | |
| `CHECK_RESULT_QUEUE_URL` | pharmacy (B send), retail (B consume) | |
| `EVENT_BUS_NAME` | retail (C) | bus for order events |
| `AWS_ENDPOINT_URL` | both | injected by floci in Lambda; set in ECS task env |

## floci layout for local runs

One floci per architecture so agents and stacks do not collide. `docker-compose.yml` reads:

| Var | A | B | C |
|---|---|---|---|
| `COMPOSE_PROJECT_NAME` | `ftw-a` | `ftw-b` | `ftw-c` |
| `FLOCI_PORT` | 4566 | 4576 | 4586 |
| `RDS_PORTS` | 7001-7010 | 7011-7020 | 7021-7030 |
| `ALB_PORTS` | 8080-8089 | 8090-8099 | 8100-8109 |
| `FLOCI_NET` | `ftw-a_default` | `ftw-b_default` | `ftw-c_default` |

`make up ARCH=a` sets them. `infra/<arch>/.env` holds the same values for CDK and tests.

## End-to-end scenario (e2e/)

Runs against any architecture given `ARCH`. Steps:

1. `GET /health` on both services.
2. Seed a prescription `RX-1` for customer `c1`, SKU `RX-FOOD-1`, expiry next year.
3. `POST /orders` for `c1`, `RX-FOOD-1`, `RX-1`. Expect eventual `FULFILLED`.
4. `POST /orders` for `c2` with the same prescription. Expect eventual `REJECTED`, reason mentions customer.
5. `POST /orders` for `c1`, non-prescription SKU `TEE-1`. Expect `FULFILLED` immediately.
6. `POST /webhooks/payment` with a bad signature. Expect 401. With a good one, 200.
7. Read the retail Lambda's CloudWatch log group and assert a line with the correlation ID from step 3 exists. (Lambda-hosted services only; ECS logs are not shipped by floci.)

Base URLs come from CloudFormation outputs `RetailApiUrl` and `PharmacyApiUrl` on the app stacks.

## Conformance tests (conformance/)

Read configuration back through the SDK and assert. Per architecture, at minimum:

- A: pharmacy Web ACL default action is `Block`; its IP set contains retail's NAT EIP; retail DB security group admits only retail's app security group on 5432; no IP set contains `0.0.0.0/0`.
- B: both queues have a DLQ with `maxReceiveCount` 3; queue policies name only the intended role ARNs; no security group has an inbound rule from `0.0.0.0/0`.
- C: pharmacy API `GET /prescriptions/{id}/check` has `authorizationType: AWS_IAM`; every security group ingress rule inside the VPC is SG-sourced, none CIDR-sourced; no NAT gateways exist; the EventBridge rule targets a queue that has a DLQ.
