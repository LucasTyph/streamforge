SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose --env-file .env -f deploy/docker-compose.yml
LOAD_ENV := set -a && source .env && set +a

.PHONY: observability dashboards grafana-password demo test-go-integration test-api-integration test-e2e media cluster platform secrets images deploy status help env dev dev-infra tf-local seed down clean test test-integration smoke lint \
        up up-lite demo load loadtest loadtest-upload benchmark chaos tf-aws-validate argocd gitops-up gitops-owner security

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

test-integration: test-go-integration test-api-integration ## Integration tests (Testcontainers + dev stack; UPLOAD_TEST_MB=100 for the big upload)

# Routing and API tests read messages back from the pipeline queues, so the workers (which
# would consume them first) are stopped for the duration and started again afterwards.
# The 21 s wait outlasts their last 20 s long-poll: ElasticMQ can still hand a new message
# to a receive whose client is already gone, hiding it for the visibility timeout.
WORKERS := probe-worker transcode-worker thumbnail-worker
STOP_WORKERS := $(COMPOSE) stop $(WORKERS) >/dev/null && sleep 21
test-api-integration: ## SNS->SQS routing + catalog-api integration tests against the dev stack
	$(STOP_WORKERS)
	scripts/smoke-messaging.sh && $(LOAD_ENV) && pnpm --filter @streamforge/catalog-api test:integration; \
	  rc=$$?; $(COMPOSE) start $(WORKERS) >/dev/null; exit $$rc

test-go-integration: ## Go worker tests with Testcontainers (SeaweedFS, ElasticMQ) and real ffmpeg
	cd go && go test -tags integration -count=1 ./...

test-e2e: media ## Playwright: upload -> READY -> plays (needs `make dev` running)
	pnpm --filter @streamforge/web exec playwright test

media: ## Generate deterministic test clips into media/
	scripts/gen-test-media.sh

smoke: ## Check SNS -> SQS routing and DLQ redrive on the dev stack (workers paused)
	$(STOP_WORKERS)
	scripts/smoke-messaging.sh; rc=$$?; $(COMPOSE) start $(WORKERS) >/dev/null; exit $$rc

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
KEDA_CHART_VERSION := 2.21.0
KPS_CHART_VERSION  := 93.1.2
LOKI_CHART_VERSION := 7.5.0
TEMPO_CHART_VERSION := 3.2.1
OTELCOL_CHART_VERSION := 0.178.3
SECRETS   := deploy/helm/secrets.local.yaml
OBS       ?= false
HELM_SET  = --namespace $(NS) -f $(SECRETS) --set global.imageTag=$(TAG) --set global.observability.enabled=$(OBS)

up-lite: cluster platform secrets images deploy ## App on k3d without observability (http://streamforge.localhost)
	@printf "\n  StreamForge is up: http://streamforge.localhost  (demo@streamforge.local / demo-password)\n\n"

up: OBS := true
up: cluster platform secrets observability images deploy ## Full stack on k3d: app + autoscaling + metrics, logs, traces
	@printf "\n  StreamForge: http://streamforge.localhost  (demo@streamforge.local / demo-password)\n"
	@printf "  Grafana:     http://grafana.streamforge.localhost  (anonymous view; admin password: make grafana-password)\n"
	@printf "  Try it:      make demo   (20 uploads -> watch 'StreamForge / Pipeline' scale 0 -> N -> 0)\n\n"

cluster: ## Create the k3d cluster (1 server, 2 agents, registry) if missing
	@k3d cluster list streamforge >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	@kubectl config use-context k3d-streamforge >/dev/null

platform: ## Install cluster operators (CloudNativePG, KEDA)
	helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
	helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
	helm repo update cnpg kedacore >/dev/null
	helm upgrade --install cnpg cnpg/cloudnative-pg --version $(CNPG_CHART_VERSION) \
	  --namespace cnpg-system --create-namespace --wait --timeout 5m \
	  --set resources.requests.cpu=50m --set resources.requests.memory=64Mi --set resources.limits.memory=256Mi
	helm upgrade --install keda kedacore/keda --version $(KEDA_CHART_VERSION) \
	  --namespace keda --create-namespace --wait --timeout 5m -f observability/values/keda.yaml

observability: ## Prometheus, Grafana, Alertmanager, Loki, Tempo, OTel Collector + StreamForge dashboards/alerts
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
	helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
	helm repo add grafana-community https://grafana-community.github.io/helm-charts >/dev/null 2>&1 || true
	helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null 2>&1 || true
	helm repo update prometheus-community grafana grafana-community open-telemetry >/dev/null
	kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null
	@kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1 || kubectl -n monitoring create secret generic grafana-admin \
	  --from-literal=admin-user=admin --from-literal=admin-password="$$(openssl rand -hex 16)" >/dev/null
	helm upgrade --install kps prometheus-community/kube-prometheus-stack --version $(KPS_CHART_VERSION) -n monitoring \
	  -f observability/values/kube-prometheus-stack.yaml --wait --timeout 10m
	helm upgrade --install loki grafana/loki --version $(LOKI_CHART_VERSION) -n monitoring -f observability/values/loki.yaml --wait --timeout 10m
	helm upgrade --install tempo grafana-community/tempo --version $(TEMPO_CHART_VERSION) -n monitoring -f observability/values/tempo.yaml --wait --timeout 10m
	helm upgrade --install otel-collector open-telemetry/opentelemetry-collector --version $(OTELCOL_CHART_VERSION) -n monitoring \
	  -f observability/values/otel-collector.yaml --wait --timeout 10m
	helm upgrade --install streamforge-observability observability/chart -n monitoring --wait

dashboards: ## Regenerate Grafana dashboard JSON from observability/dashboards.py
	python3 observability/dashboards.py

grafana-password: ## Print the Grafana admin password
	@kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d; echo

secrets: ## Generate random local secrets into deploy/helm/secrets.local.yaml (gitignored)
	@[ -f $(SECRETS) ] || { printf 's3:\n  accessKey: "sf%s"\n  secretKey: "%s"\njwtSecret: "%s"\n' \
	  "$$(openssl rand -hex 6)" "$$(openssl rand -hex 24)" "$$(openssl rand -hex 32)" > $(SECRETS) && echo "created $(SECRETS)"; }

images: ## Build all images and push them to the k3d registry (tag: $(TAG))
	@build() { docker build -q -t $(REGISTRY)/streamforge/$$1:$(TAG) "$${@:2}" >/dev/null && docker push -q $(REGISTRY)/streamforge/$$1:$(TAG) >/dev/null && echo "pushed $$1:$(TAG)"; }; \
	build sns-shim --build-arg CMD=sns-shim go & p1=$$!; \
	build progress-svc --build-arg CMD=progress go & p2=$$!; \
	build probe-worker -f go/Dockerfile.ffmpeg --build-arg CMD=probe go & p3=$$!; \
	build transcode-worker -f go/Dockerfile.ffmpeg --build-arg CMD=transcode go & p4=$$!; \
	build thumbnail-worker -f go/Dockerfile.ffmpeg --build-arg CMD=thumbnail go & p5=$$!; \
	build terraform-local infra/terraform & p6=$$!; \
	build catalog-api -f services/catalog-api/Dockerfile --build-arg APP_VERSION=$(TAG) . & p7=$$!; \
	build web -f apps/web/Dockerfile . & p8=$$!; \
	fail=0; for p in $$p1 $$p2 $$p3 $$p4 $$p5 $$p6 $$p7 $$p8; do wait $$p || fail=1; done; \
	[ $$fail = 0 ] || { echo "image build failed"; exit 1; }

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
DEMO_N ?= 20
demo: ## Upload DEMO_N (20) clips at once to the k3d stack; watch Grafana 'StreamForge / Pipeline'
	scripts/gen-test-media.sh demo $(DEMO_N)
	API_URL=http://streamforge.localhost/api node scripts/upload-videos.mjs --expect READY media/demo/*.mp4

loadtest load: ## k6 API load test (RATE=50 req/s, DURATION=2m) against the k3d stack
	k6 run -e RATE=$(or $(RATE),50) -e DURATION=$(or $(DURATION),2m) loadtest/k6/api-browse.js

loadtest-upload: ## k6 upload burst: VUS (10) users upload one clip each at the same time
	scripts/gen-test-media.sh demo 20 >/dev/null
	k6 run -e VUS=$(or $(VUS),10) loadtest/k6/upload-burst.js

benchmark: ## Batch benchmark at max transcode workers 1, 2 and 4 (results in bench/)
	scripts/benchmark.sh bench

chaos: ## Kill random worker pods during a 20-clip batch; verify nothing is lost or duplicated
	scripts/chaos.sh bench

# ---- GitOps (ArgoCD) ---------------------------------------------------------
ARGOCD_CHART_VERSION := 10.17.1
OWNER ?=

gitops-owner: ## Point GitOps files at your GitHub repo/GHCR: make gitops-owner OWNER=<github user>
	@[ -n "$(OWNER)" ] || { echo "usage: make gitops-owner OWNER=<github user>"; exit 1; }
	sed -i "s#ghcr.io/[A-Za-z0-9_.-]*#ghcr.io/$$(echo $(OWNER) | tr A-Z a-z)#; s#github.com/[A-Za-z0-9_.-]*/streamforge.git#github.com/$(OWNER)/streamforge.git#" \
	  deploy/gitops/*/values.yaml deploy/argocd/apps/values.yaml deploy/argocd/bootstrap/root.yaml
	@grep -rnE "ghcr.io/OWNER|github.com/OWNER/" deploy/gitops deploy/argocd && exit 1 || echo "GitOps files now point at $(OWNER)"

argocd: cluster ## Install ArgoCD (UI: http://argocd.streamforge.localhost)
	helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
	helm repo update argo >/dev/null
	helm upgrade --install argocd argo/argo-cd --version $(ARGOCD_CHART_VERSION) --namespace argocd --create-namespace \
	  -f deploy/argocd/argocd-values.yaml --wait --timeout 10m

gitops-up: argocd ## ArgoCD + per-env secrets + root app: staging & prod follow git (main)
	@grep -q "github.com/OWNER/" deploy/argocd/bootstrap/root.yaml && { echo "run 'make gitops-owner OWNER=<github user>' first"; exit 1; } || true
	scripts/gitops-secrets.sh streamforge-staging
	kubectl apply -f deploy/argocd/bootstrap/root.yaml
	@printf "\n  ArgoCD: http://argocd.streamforge.localhost  user: admin  password: "
	@kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
	@printf "  staging: http://staging.streamforge.localhost   prod: http://prod.streamforge.localhost\n\n"

# ---- Infra checks (same pinned tools as CI, via their official images) ---------
tf-aws-validate: ## Validate + tflint + checkov the real-AWS Terraform (never applied)
	cd infra/terraform/aws && terraform init -backend=false -input=false >/dev/null && terraform validate
	docker run --rm -v "$$PWD/infra/terraform:/data" -w /data/aws --entrypoint sh ghcr.io/terraform-linters/tflint:v0.66.0 \
	  -c "tflint --init --config /data/.tflint.hcl >/dev/null && tflint --config /data/.tflint.hcl && cd ../local && tflint --config /data/.tflint.hcl && cd ../modules/pipeline && tflint --config /data/.tflint.hcl"
	docker run --rm -v "$$PWD/infra/terraform:/tf" bridgecrew/checkov:3.4.3 -d /tf/aws --framework terraform \
	  --config-file /tf/aws/.checkov.yaml --download-external-modules true --quiet --compact

security: ## gitleaks + Trivy (deps, Dockerfiles, Helm misconfig, secrets) + actionlint
	docker run --rm -v "$$PWD:/repo" zricethezav/gitleaks:v8.30.1 git /repo --redact --no-banner
	docker run --rm -v "$$PWD:/repo" -w /repo -v trivy-cache:/root/.cache aquasec/trivy:0.76.2 fs --config trivy.yaml \
	  --scanners vuln,misconfig,secret --exit-code 1 .
	docker run --rm -v "$$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
