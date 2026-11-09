SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
LOAD_ENV := set -a && source .env && set +a

.PHONY: test-go-integration test-e2e media help env dev dev-infra tf-local seed down clean test test-integration smoke lint \
        up up-lite demo load chaos tf-aws-validate

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

env:
	@[ -f .env ] || { cp .env.example .env && echo "created .env from .env.example"; }

dev: dev-infra tf-local seed ## Full dev loop: infra in Docker, API + web on the host with hot reload
	pnpm --parallel --filter @streamforge/catalog-api --filter @streamforge/web dev

dev-infra: env ## Start Postgres, Redis, SeaweedFS, ElasticMQ, sns-shim
	pnpm install --frozen-lockfile
	$(COMPOSE) up -d --build --wait --wait-timeout 120 postgres redis
	$(COMPOSE) up -d --build seaweedfs elasticmq sns-shim probe-worker transcode-worker thumbnail-worker progress-svc
	@scripts/wait-for.sh http://localhost:8333/status http://localhost:9324/ http://localhost:9911/healthz http://localhost:4001/healthz

tf-local: env ## Create buckets/topics/subscriptions on the emulators
	$(LOAD_ENV) && cd infra/terraform/local && terraform init -input=false >/dev/null && \
	  terraform apply -auto-approve -input=false

seed: env ## Create the demo user (credentials in .env)
	$(LOAD_ENV) && pnpm --filter @streamforge/catalog-api seed

down: ## Stop the dev stack (keeps data)
	$(COMPOSE) down

clean: ## Stop the dev stack and delete all data + local Terraform state
	$(COMPOSE) down -v
	rm -f infra/terraform/local/terraform.tfstate*

test: ## Unit tests (Go + TS)
	cd go && go test ./...
	pnpm -r test

test-integration: test-go-integration ## Integration tests (Testcontainers + running dev stack; UPLOAD_TEST_MB=100 for the big upload)
	scripts/smoke-messaging.sh
	$(LOAD_ENV) && pnpm --filter @streamforge/catalog-api test:integration

test-go-integration: ## Go worker tests with Testcontainers (SeaweedFS, ElasticMQ) and real ffmpeg
	cd go && go test -tags integration -count=1 ./...

test-e2e: media ## Playwright: upload -> READY -> plays (needs `make dev` running)
	pnpm --filter @streamforge/web exec playwright test

media: ## Generate deterministic test clips into media/
	scripts/gen-test-media.sh

smoke: ## Check SNS -> SQS routing and DLQ redrive on the dev stack
	scripts/smoke-messaging.sh

lint: ## Static checks
	cd go && go vet ./... && test -z "$$(gofmt -l .)"
	pnpm -r lint
	terraform fmt -check -recursive infra/terraform

up up-lite: ## (M4) Full stack on k3d
	@echo "'make $@' arrives in M4 (Kubernetes). Use 'make dev' for now."; exit 1
demo load chaos: ## (M6/M7) Scaling demo, load tests, chaos
	@echo "'make $@' arrives in M6/M7."; exit 1
tf-aws-validate: ## (M5) Validate the real-AWS Terraform
	@echo "'make $@' arrives in M5."; exit 1
