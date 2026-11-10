#!/usr/bin/env bash
# Sets image tags in a GitOps images file from a directory of <service> -> <tag> files
# (written by release.yml). Only services that were rebuilt change; the rest keep their tag.
# Usage: scripts/gitops-bump.sh deploy/gitops/staging/images.yaml built/
set -euo pipefail
file=$1 dir=$2
key() {
  case "$1" in
    catalog-api) echo catalogApi ;; web) echo web ;; progress-svc) echo progressSvc ;;
    probe-worker) echo probeWorker ;; transcode-worker) echo transcodeWorker ;;
    thumbnail-worker) echo thumbnailWorker ;; sns-shim) echo snsShim ;; terraform-local) echo terraform ;;
    *) echo "unknown service $1" >&2; exit 1 ;;
  esac
}
for f in "$dir"/*; do
  [ -f "$f" ] || continue
  svc=$(basename "$f") tag=$(tr -d '[:space:]' < "$f")
  [[ "$tag" =~ ^[0-9a-f]{7,40}$ ]] || { echo "refusing tag '$tag' for $svc" >&2; exit 1; }
  k=$(key "$svc")
  grep -q "^$k: " "$file" || { echo "$k missing from $file" >&2; exit 1; }
  sed -i -E "s|^($k: \{ image: \{ tag: )\"[^\"]*\"|\1\"$tag\"|" "$file"
  echo "$k -> $tag"
done
