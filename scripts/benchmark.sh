#!/usr/bin/env bash
# Batch benchmark: uploads the same N clips with the transcode worker ceiling set to each
# value in WORKERS (KEDA maxReplicaCount), and records total time, throughput and
# time-to-ready percentiles. Needs `make up` (or up-lite) and `make media`-style demo clips.
# Usage: scripts/benchmark.sh [outdir]      env: WORKERS="1 2 4"  N=20  NS=streamforge
set -euo pipefail
out=${1:-bench}; ns=${NS:-streamforge}; n=${N:-20}
mkdir -p "$out"
scripts/gen-test-media.sh demo "$n" >/dev/null
mapfile -t files < <(ls media/demo/*.mp4 | head -n "$n")
orig=$(kubectl -n "$ns" get scaledobject transcode-worker -o jsonpath='{.spec.maxReplicaCount}')
restore() { kubectl -n "$ns" patch scaledobject transcode-worker --type merge -p "{\"spec\":{\"maxReplicaCount\":$orig}}" >/dev/null; }
trap restore EXIT

idle() { # wait until every worker has scaled back to zero, so each run starts cold
  until [ "$(kubectl -n "$ns" get deploy probe-worker transcode-worker thumbnail-worker -o jsonpath='{range .items[*]}{.status.replicas}{end}' | tr -d 0)" = "" ]; do sleep 5; done
}

for w in ${WORKERS:-1 2 4}; do
  kubectl -n "$ns" patch scaledobject transcode-worker --type merge -p "{\"spec\":{\"maxReplicaCount\":$w}}" >/dev/null
  idle
  echo "== max transcode workers: $w ($n clips)"
  API_URL=${API_URL:-http://streamforge.localhost/api} node scripts/upload-videos.mjs --expect READY --verify \
    --json "$out/workers-$w.json" "${files[@]}" | grep -E "^(FAIL|summary)" || true
done
restore
echo
printf "%-8s %-7s %-9s %-11s %-9s %-9s %s\n" workers videos total_s videos/min p50_s p95_s extra_attempts
for w in ${WORKERS:-1 2 4}; do
  jq -r --arg w "$w" '.summary | [$w, "\(.ready)/\(.videos)", .totalSeconds, .videosPerMinute, .timeToReadyP50, .timeToReadyP95, .extraAttempts] | @tsv' "$out/workers-$w.json" |
    awk -F'\t' '{printf "%-8s %-7s %-9s %-11s %-9s %-9s %s\n", $1,$2,$3,$4,$5,$6,$7}'
done
