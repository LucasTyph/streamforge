# Runbook: a DLQ is filling (`StreamForgeDLQNotEmpty`)

A message reaches a dead-letter queue after 3 failed attempts (ADR-003). The video it
belongs to is already `FAILED` with a reason, so users see it; this runbook gets the work done.

## 1. Look
- **Ops page** (`/admin`): DLQ count per queue, "Inspect DLQ" shows the messages
  (type, videoId, receive count, body). Peeking leaves them in the queue.
- **Grafana → StreamForge / Pipeline**: "Warnings and errors" (logs) and "Recent transcode
  traces". Every worker log line has `trace_id`; click it to open the trace in Tempo.
- **Admin API**: `GET /api/admin/jobs/failed` lists recent failed jobs with their reason.

## 2. Classify the failure
| What the trace/logs show | Meaning | Action |
|---|---|---|
| `ffmpeg: ... Server returned 404` / `NoSuchKey` | the source object is gone | nothing to redrive; delete the video |
| S3/SQS timeouts, `connection refused`, OOMKilled pods | infrastructure was unhealthy | fix it (step 3), then redrive |
| same error on every attempt with a valid file | a bug | fix and deploy, then redrive |

Permanent input problems (not a video, too long) never reach the DLQ: they fail
immediately with a reason and the message is deleted.

## 3. Fix, then redrive
```bash
kubectl -n streamforge get pods                       # anything restarting / pending?
kubectl -n streamforge describe pod <pod> | tail -20  # OOMKilled? evicted?
```
Then **Ops page → Redrive** (or `POST /api/admin/dlq/<queue>/redrive`). Messages go back to
the source queue; the job moves `FAILED -> RUNNING` and the video back to `PROCESSING`.
Redrive is safe to repeat: outputs are idempotent (ADR-003).
