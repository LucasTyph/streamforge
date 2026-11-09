SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
LOAD_ENV := set -a && source .env && set +a

.PHONY: test-go-integration test-e2e media cluster platform secrets images deploy status help env dev dev-infra tf-local seed down clean test test-integration smoke lint \
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

dev-down: ## Stop the docker-compose dev stack (keeps data)
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
	for c in streamforge-deps streamforge; do helm dependency build deploy/helm/$$c >/dev/null && helm lint --quiet deploy/helm/$$c --set global.imageTag=lint --set jwtSecret=lint --set s3.accessKey=lint --set s3.secretKey=lint; done

# ---- Kubernetes (k3d) -------------------------------------------------------
NS        := streamforge
REGISTRY  := localhost:5111
# Immutable tags: git SHA, plus a timestamp when the tree has uncommitted changes.
# Evaluated once (:=); a lazy ?= re-runs `date` on every reference, so images and deploy disagree.
ifndef TAG
TAG := $(shell git rev-parse --short HEAD)$(shell git diff --quiet HEAD -- . ':!docs' || echo "-dev$$(date +%s)")
endif
CNPG_CHART_VERSION := 0.29.1
SECRETS   := deploy/helm/secrets.local.yaml
HELM_SET  := --namespace $(NS) -f $(SECRETS) --set global.imageTag=$(TAG)

up-lite: cluster platform secrets images deploy ## App on k3d without observability (http://streamforge.localhost)
	@printf "\n  StreamForge is up: http://streamforge.localhost  (demo@streamforge.local / demo-password)\n\n"

up: up-lite ## Full stack on k3d (observability is added in M6)
	@echo "Observability stack arrives in M6; 'make up' currently equals 'make up-lite'."

cluster: ## Create the k3d cluster (1 server, 2 agents, registry) if missing
	@k3d cluster list streamforge >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	@kubectl config use-context k3d-streamforge >/dev/null

platform: ## Install cluster operators (CloudNativePG)
	helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
	helm repo update cnpg >/dev/null
	helm upgrade --install cnpg cnpg/cloudnative-pg --version $(CNPG_CHART_VERSION) \
	  --namespace cnpg-system --create-namespace --wait --timeout 5m \
	  --set resources.requests.cpu=50m --set resources.requests.memory=64Mi --set resources.limits.memory=256Mi

secrets: ## Generate random local secrets into deploy/helm/secrets.local.yaml (gitignored)
	@[ -f $(SECRETS) ] || { printf 's3:\n  accessKey: "sf%s"\n  secretKey: "%s"\njwtSecret: "%s"\n' \
	  "$$(openssl rand -hex 6)" "$$(openssl rand -hex 24)" "$$(openssl rand -hex 32)" > $(SECRETS) && echo "created $(SECRETS)"; }

images: ## Build all images and push them to the k3d registry (tag: $(TAG))
	@set -e; build() { docker build -q -t $(REGISTRY)/streamforge/$$1:$(TAG) "$${@:2}" >/dev/null && docker push -q $(REGISTRY)/streamforge/$$1:$(TAG) >/dev/null && echo "pushed $$1:$(TAG)"; }; \
	build sns-shim --build-arg CMD=sns-shim go & \
	build progress-svc --build-arg CMD=progress go & \
	build probe-worker -f go/Dockerfile.ffmpeg --build-arg CMD=probe go & \
	build transcode-worker -f go/Dockerfile.ffmpeg --build-arg CMD=transcode go & \
	build thumbnail-worker -f go/Dockerfile.ffmpeg --build-arg CMD=thumbnail go & \
	build terraform-local infra/terraform & \
	build catalog-api -f services/catalog-api/Dockerfile . & \
	build web -f apps/web/Dockerfile . & \
	wait

deploy: ## helm upgrade --install both releases (deps, then app)
	helm dependency build deploy/helm/streamforge-deps >/dev/null
	helm dependency build deploy/helm/streamforge >/dev/null
	helm upgrade --install streamforge-deps deploy/helm/streamforge-deps $(HELM_SET) --create-namespace --wait --timeout 10m
	helm upgrade --install streamforge deploy/helm/streamforge $(HELM_SET) --wait --timeout 10m

status: ## Pods, ingress and resource usage on k3d
	kubectl -n $(NS) get pods -o wide
	kubectl -n $(NS) get ingress
	kubectl top pods -n $(NS) 2>/dev/null || true

down: ## Delete the k3d cluster (and stop the docker-compose dev stack)
	-k3d cluster delete streamforge
	$(COMPOSE) down
demo load chaos: ## (M6/M7) Scaling demo, load tests, chaos
	@echo "'make $@' arrives in M6/M7."; exit 1
tf-aws-validate: ## (M5) Validate the real-AWS Terraform
	@echo "'make $@' arrives in M5."; exit 1
