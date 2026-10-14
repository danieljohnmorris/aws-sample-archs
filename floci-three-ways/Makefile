# Usage: make up ARCH=a ; make deploy ARCH=a ; make e2e ARCH=a ; make down ARCH=a
# ARCH is a, b or c (the three ways), or simple-vpc or monolith (the
# Simplified pair). ARCH=local and ARCH=monolith-local are the exceptions:
# no floci, no stacks, e2e runs the servers in-process against a local
# Postgres. There is no infra/local/.env, so the include is optional.
ARCH ?= a
ENV  := infra/$(ARCH)/.env
-include $(ENV)
export

# The monolith has one app stack. Every other architecture has two.
ifeq ($(ARCH),monolith)
APP_STACKS := App
else
APP_STACKS := PharmacyApp RetailApp
endif

.PHONY: test-deps destroy-apps infra-deps up down logs deps images bootstrap deploy destroy unit e2e conformance

up:
	docker compose --env-file $(ENV) up -d --wait

down:
	docker compose --env-file $(ENV) down -v
	docker ps -q --filter "name=floci-" --filter "network=$(FLOCI_NET)" | xargs -r docker rm -f

logs:
	docker compose --env-file $(ENV) logs -f floci

# Lambda assets are the app directories zipped whole, node_modules included.
# The AWS SDK stays in dependencies rather than relying on the runtime copy.
deps: test-deps infra-deps
	cd apps/retail && npm ci --omit=dev
	cd apps/pharmacy && npm ci --omit=dev
	cd apps/monolith && npm ci --omit=dev

images:
	docker build -t ftw-retail:local apps/retail
	docker build -t ftw-pharmacy:local apps/pharmacy
	docker build -t ftw-monolith:local apps/monolith

bootstrap:
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 bootstrap aws://$(CDK_DEFAULT_ACCOUNT)/$(CDK_DEFAULT_REGION)

deploy: deps images
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 deploy --all --require-approval never
	./scripts/outputs.sh $(ARCH)

destroy:
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 destroy --all --force

unit:
	cd apps/retail && node --test
	cd apps/pharmacy && node --test
	cd apps/monolith && node --test

e2e:
	cd e2e && ARCH=$(ARCH) node --test

conformance:
	cd conformance && ARCH=$(ARCH) node --test

# e2e/ and conformance/ carry their own dependencies.
test-deps:
	cd e2e && npm ci --silent
	cd conformance && npm ci --silent

# floci cannot update a stack, so redeploying means destroying the app stacks
# first. --exclusively keeps the base stacks, and their databases, out of it.
destroy-apps:
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 destroy --exclusively $(APP_STACKS) --force

deploy-apps: deps
	cd infra/$(ARCH) && npx aws-cdk@2.1139.0 deploy --exclusively $(APP_STACKS) --require-approval never
	./scripts/outputs.sh $(ARCH)

infra-deps:
	cd infra/$(ARCH) && npm ci --silent
