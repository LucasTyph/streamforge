#!/usr/bin/env bash
# Chaos test: while a batch of N clips is processed, kill a random pipeline worker pod
# every INTERVAL seconds, alternating graceful deletes (SIGTERM: the worker releases or
# finishes its message) and hard kills (--grace-period=0: the message reappears after its
# visibility timeout). Then verify nothing was lost or duplicated:
#   - every video READY, every HLS variant intact (all segments present, durations add up)
#   - exactly one job row per (video, task), all SUCCEEDED (unique constraint + API check)
#   - jobs killed on all 3 receives are dead-lettered and marked FAILED (not lost): the
#     script redrives them and requires them to finish too; all DLQs empty at the end
# Usage: scripts/chaos.sh [outdir]     env: N=20 INTERVAL=12 NS=streamforge
set -uo pipefail
out=${1:-bench}; ns=${NS:-streamforge}; n=${N:-20}; interval=${INTERVAL:-12}
api=${API_URL:-http://streamforge.localhost/api}
mkdir -p "$out"; log="$out/chaos-kills.log"; : > "$log"
scripts/gen-test-media.sh demo "$n" >/dev/null
mapfile -t files < <(ls media/demo/*.mp4 | head -n "$n")

killer() {
  local i=0
  while :; do
    sleep "$interval"
    pod=$(kubectl -n "$ns" get pods -l 'app.kubernetes.io/name in (probe-worker,transcode-worker,thumbnail-worker)' \
      --field-selector=status.phase=Running -o name 2>/dev/null | shuf -n 1)
    [ -z "$pod" ] && continue
    i=$((i + 1))
    if [ $((i % 2)) -eq 0 ]; then mode=hard; kubectl -n "$ns" delete "$pod" --grace-period=0 --force >/dev/null 2>&1
    else mode=graceful; kubectl -n "$ns" delete "$pod" --wait=false >/dev/null 2>&1; fi
    echo "$(date +%T) $mode ${pod#pod/}" | tee -a "$log"
  done
}
killer & kpid=$!
trap 'kill $kpid 2>/dev/null' EXIT

API_URL=$api timeout ${TIMEOUT:-1500} node scripts/upload-videos.mjs --expect READY --verify --json "$out/chaos.json" "${files[@]}" > "$out/chaos.out" 2>&1
rc=$?
kill $kpid 2>/dev/null; wait $kpid 2>/dev/null

host=$(echo "$api" | sed -E 's#http://([^/]+)/.*#\1#') # *.localhost: connect to 127.0.0.1, keep the Host header
cookie=$(curl -s -i -H "Host: $host" -H 'content-type: application/json' \
  -d "{\"email\":\"${SEED_USER_EMAIL:-demo@streamforge.local}\",\"password\":\"${SEED_USER_PASSWORD:-demo-password}\"}" \
  http://127.0.0.1/api/auth/login | grep -i '^set-cookie' | sed -E 's/^[^:]+: ([^;]+).*/\1/')
admin() { curl -s -X "${2:-GET}" -H "Host: $host" -H "cookie: $cookie" "http://127.0.0.1/api/admin/$1"; }
dlq_depth() { admin queues | jq '[.queues[].dlq | .visible + .inFlight] | add'; }

echo
grep -E "^summary" "$out/chaos.out" || tail -5 "$out/chaos.out"
kills=$(wc -l < "$log"); hard=$(grep -c " hard " "$log")
echo "pods killed: $kills ($hard hard, $((kills - hard)) graceful)"
first_ready=$(jq '.summary.ready' "$out/chaos.json"); total=$(jq '.summary.videos' "$out/chaos.json")
mapfile -t failed < <(jq -r '.results[] | select(.status != "READY") | .id' "$out/chaos.json")
echo "after the batch: $first_ready/$total READY, ${#failed[@]} FAILED (dead-lettered: $(dlq_depth) messages)"

# A job killed on each of its 3 receives is dead-lettered, not lost: redrive and re-check.
if [ ${#failed[@]} -gt 0 ]; then
  for q in probe transcode thumbnail; do echo "redrive $q: $(admin "dlq/$q/redrive" POST)"; done
  API_URL=$api timeout 600 node scripts/upload-videos.mjs --ids --expect READY --verify --json "$out/chaos-redrive.json" "${failed[@]}" > "$out/chaos-redrive.out" 2>&1
  rc=$?
  recovered=$(jq '.summary.ready // ([.results[] | select(.status=="READY")] | length)' "$out/chaos-redrive.json" 2>/dev/null || echo 0)
  echo "after redrive: $recovered/${#failed[@]} recovered"
fi
problems=$(jq -s '[.[].results[].problems | length] | add' "$out"/chaos.json $( [ ${#failed[@]} -gt 0 ] && echo "$out/chaos-redrive.json" ))
dlq=$(dlq_depth)
echo "integrity problems: $problems; dead-lettered messages left: $dlq"
[ "$rc" -eq 0 ] && [ "$dlq" = "0" ] && [ "$problems" = "0" ] && echo "CHAOS PASS: no lost or duplicated work" || { echo "CHAOS FAIL (see $out/chaos*.out)"; exit 1; }
