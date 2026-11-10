#!/usr/bin/env bash
# Creates the Secrets a GitOps environment needs, with random values, if they don't exist.
# Secret values never go to git; ArgoCD-managed releases run with secrets.create=false.
# Usage: scripts/gitops-secrets.sh <namespace> [<namespace>...]
# (A shared cluster would use Sealed Secrets or External Secrets instead, see ADR-006.)
set -euo pipefail
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1 || {
  kubectl -n monitoring create secret generic grafana-admin     --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -hex 16)" >/dev/null
  echo "created monitoring/grafana-admin"
}
for ns in "$@"; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  if ! kubectl -n "$ns" get secret streamforge-s3 >/dev/null 2>&1; then
    ak="sf$(openssl rand -hex 6)"; sk="$(openssl rand -hex 24)"
    s3json=$(printf '{"identities":[{"name":"streamforge","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]},{"name":"anonymous","actions":["Read:streamforge-processed"]}]}' "$ak" "$sk")
    kubectl -n "$ns" create secret generic streamforge-s3 \
      --from-literal=accessKey="$ak" --from-literal=secretKey="$sk" --from-literal=s3.json="$s3json" >/dev/null
    echo "created $ns/streamforge-s3"
  fi
  if ! kubectl -n "$ns" get secret streamforge-app >/dev/null 2>&1; then
    kubectl -n "$ns" create secret generic streamforge-app \
      --from-literal=jwtSecret="$(openssl rand -hex 32)" --from-literal=seedPassword="${SEED_USER_PASSWORD:-demo-password}" >/dev/null
    echo "created $ns/streamforge-app"
  fi
done
