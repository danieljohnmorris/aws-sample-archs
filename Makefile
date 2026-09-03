# Usage: make up ARCH=a ; make deploy ARCH=a ; make e2e ARCH=a ; make down ARCH=a
# ARCH=local is the exception: no floci, no stacks, e2e runs both servers
# in-process against a local Postgres. There is no infra/local/.env, so the
# include is optional.
ARCH ?= a
ENV  := infra/$(ARCH)/.env
-include $(ENV)
export

.PHONY: up down logs deps images bootstrap deploy destroy unit e2e conformance

up:
	docker compose --env-file $(ENV) up -d --wait

down:
	docker compose --env-file $(ENV) down -v
	docker ps -q --filter "name=floci-" --filter "network=$(FLOCI_NET)" | xargs -r docker rm -f

logs:
	docker compose --env-file $(ENV) logs -f floci

# Lambda assets are the app directories zipped whole, node_modules included.
# The AWS SDK stays in dependencies rather than relying on the runtime copy.
deps:
	cd apps/retail && npm ci --omit=dev
	cd apps/pharmacy && npm ci --omit=dev

images:
	docker build -t ftw-retail:local apps/retail
	docker build -t ftw-pharmacy:local apps/pharmacy

bootstrap:
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 bootstrap aws://$(CDK_DEFAULT_ACCOUNT)/$(CDK_DEFAULT_REGION)

deploy: deps images
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 deploy --all --require-approval never --outputs-file outputs.json

destroy:
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 destroy --all --force

unit:
	cd apps/retail && node --test
	cd apps/pharmacy && node --test

e2e:
	cd e2e && ARCH=$(ARCH) node --test

conformance:
	cd conformance && ARCH=$(ARCH) node --test
