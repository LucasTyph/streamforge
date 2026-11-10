# Runbook: workers are stuck, slow or crash-looping

Alerts: `StreamForgeTranscodeSlow` (p95 transcode > 2 min for 5 min),
`StreamForgeWorkerCrashLooping` (> 3 restarts in 10 min).

## Symptoms and checks
| Symptom | Check |
|---|---|
| Queue depth rises, worker replicas stay at 0 | `kubectl -n streamforge get scaledobject` (READY/ACTIVE); `kubectl -n keda logs deploy/keda-operator --tail 50`. KEDA must reach ElasticMQ: the `elasticmq` NetworkPolicy allows the `keda` namespace |
| Replicas at max, queue not draining | Grafana "Job duration p95" and per-pod CPU: CPU-bound transcodes are expected to queue at `maxReplicaCount` (4); raise it only if the nodes have room |
| Pods restarting | `kubectl -n streamforge describe pod <pod>`: `OOMKilled` means the source video needs more memory than the limit (transcode: 1Gi) |
| A job never finishes | its trace in Tempo shows which step hangs (download, ffmpeg, upload); worker logs have the same `trace_id` |

## Why a stuck job doesn't lose work
- Workers extend the message visibility (heartbeat) while they run. If a worker dies, the
  message reappears within the visibility timeout (2 min) and another worker takes it.
- On scale-down or rollout, SIGTERM makes a worker release its message (transcode) or
  finish it (probe, thumbnail) before exiting (ADR-003).
- After 3 failed attempts the message goes to the DLQ: see `dlq-filling.md`.

## Useful commands
```bash
kubectl -n streamforge get scaledobject,hpa
kubectl -n streamforge logs deploy/transcode-worker --tail 100 | jq -r '"\(.time) \(.level) \(.msg) \(.trace_id // "")"'
kubectl -n streamforge top pods
```
