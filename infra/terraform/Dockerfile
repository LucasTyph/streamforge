# Terraform + this repo's modules, with providers in a filesystem mirror so the in-cluster
# Job installs them offline (its NetworkPolicy blocks internet egress, and a plain
# `terraform init` would still contact registry.terraform.io). Build context: infra/terraform.
FROM hashicorp/terraform:1.17.1
ARG TARGETOS=linux TARGETARCH=amd64
# The upstream image lags Alpine security fixes (Trivy found CRITICAL openssh CVEs in
# alpine 3.24.3); apply them at build time.
RUN apk upgrade --no-cache
COPY modules /tf/modules
COPY local/main.tf local/.terraform.lock.hcl /tf/local/
# init (modules + providers, needs network at build time) -> mirror as zips for the target
# architecture -> drop the unpacked copy so the provider is only stored once.
RUN cd /tf/local && terraform init -backend=false -input=false >/dev/null \
 && terraform providers mirror -platform=${TARGETOS}_${TARGETARCH} /tf/providers >/dev/null \
 && rm -rf /tf/local/.terraform \
 && printf 'provider_installation {\n  filesystem_mirror {\n    path    = "/tf/providers"\n    include = ["registry.terraform.io/*/*"]\n  }\n}\n' > /tf/terraformrc \
 && chmod -R a+rX /tf
ENV TF_CLI_CONFIG_FILE=/tf/terraformrc
USER 65532:65532
