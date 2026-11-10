#!/usr/bin/env bash
# Samples queue depth (Prometheus: catalog-api's queue gauges, visible + in flight, 15 s
# scrape) and ready worker replicas (Kubernetes) every INTERVAL seconds into a CSV, until
# STOP_FILE exists and HOLD more seconds have passed (to capture the scale back to zero).
# Usage: scripts/scaling-timeline.sh out.csv [namespace]
set -euo pipefail
out=$1 ns=${2:-streamforge}
INTERVAL=${INTERVAL:-5} HOLD=${HOLD:-240} STOP_FILE=${STOP_FILE:-/tmp/scaling-timeline.stop}
rm -f "$STOP_FILE"
kubectl -n monitoring port-forward svc/kps-prometheus 19091:9090 >/dev/null 2>&1 &
pf=$!; trap 'kill $pf 2>/dev/null' EXIT; sleep 3

depths() { # -> "probe,transcode,thumbnail"
  curl -s localhost:19091/api/v1/query --data-urlencode \
    "query=max by (queue) (sum by (queue, pod) (streamforge_queue_messages{namespace=\"$ns\", dlq=\"false\", state=~\"visible|in_flight\"}))" |
    jq -r '[.data.result[] | {(.metric.queue): .value[1]}] | add // {} | "\(.probe // 0),\(.transcode // 0),\(.thumbnail // 0)"'
}
replicas() { kubectl -n "$ns" get deploy "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null | sed 's/^$/0/'; }

echo "t_seconds,probe_queue,transcode_queue,thumbnail_queue,probe_workers,transcode_workers,thumbnail_workers" > "$out"
t0=$(date +%s) stopped_at=""
while :; do
  now=$(date +%s)
  echo "$((now - t0)),$(depths),$(replicas probe-worker),$(replicas transcode-worker),$(replicas thumbnail-worker)" >> "$out"
  if [ -f "$STOP_FILE" ]; then
    stopped_at=${stopped_at:-$now}
    [ $((now - stopped_at)) -ge "$HOLD" ] && break
  fi
  sleep "$INTERVAL"
done
