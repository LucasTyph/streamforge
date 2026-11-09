# ADR-003: Pipeline idempotency, retries and failure handling

- **Status:** Accepted
- **Date:** 2026-11-09

## Context
SNS/SQS deliver at least once and don't guarantee order. Workers crash, get rescheduled
and receive SIGTERM mid-job. Uploads can be corrupt or break product limits. The pipeline
must neither lose nor duplicate work, and users must see a clear reason when a video fails.

## Decisions

**Who owns state.** Only catalog-api writes to Postgres. Workers publish `job.status`
events (RUNNING / SUCCEEDED / FAILED) to the `job-status` topic, and catalog-api consumes
them from `catalog-status-q`. The workers don't need database credentials, and the state
machine lives in one place.

**Job state machine.** `jobs` has a unique `(video_id, task)` and states
`PENDING → RUNNING → SUCCEEDED | FAILED`. `SUCCEEDED` is terminal: duplicate or late events
can't undo it. `FAILED → RUNNING` is allowed, because a DLQ redrive retries the job. Events
older than the job's `last_event_at` are ignored, since SQS doesn't guarantee order. Each
event is applied in one transaction that locks the video row, so concurrent events for the
same video serialize. Video status is derived from the jobs: any FAILED → `FAILED`; all
`REQUIRED_TASKS` succeeded → `READY`; otherwise `PROCESSING`.

**Idempotent outputs.** Output keys are deterministic (`{videoId}/hls/{rendition}/...`), and
the transcoder uploads segments and variant playlists first and `master.m3u8` **last**. The
master playlist is the commit marker: if it exists, a redelivered message only re-publishes
SUCCEEDED and does no work. An interrupted run leaves no master, so the next attempt
overwrites the same keys with output from the same input and arguments. We considered a
temp prefix with a copy-to-final step and rejected it: S3 has no atomic rename, so it would
cost a second full write of every segment and add nothing, since deterministic keys plus a
last-written commit marker already guarantee readers never see a partial ladder.

**Upload event.** catalog-api publishes `video-uploaded` *before* flipping the video to
`UPLOADED`. A crash in between leads to a retried `complete` call and a duplicate event,
which the steps above absorb, never to a lost event.

**Retries and DLQ.** Each queue has `maxReceiveCount = 3` and a DLQ. The shared consumer
(`go/internal/worker`) classifies errors:
- *permanent* (malformed message, unreadable or invalid video): publish FAILED with a
  user-facing reason, then delete the message;
- *transient*: make the message visible again after `10 s × attempt`. On the 3rd attempt,
  publish FAILED ("Processing failed after 3 attempts") and leave the message for SQS to
  move to the DLQ, where it can be inspected and redriven (M3 adds the admin page).

**Long jobs.** While a handler runs, the consumer extends the message's visibility timeout
(`ChangeMessageVisibility`): transcode every 30 s to 120 s, probe every 20 s to 60 s. A
crashed worker's message reappears within 2 minutes.

**Graceful shutdown.** On SIGTERM the worker stops polling and gives the in-flight message
`DrainTimeout` to finish: 30 s for probe, which is short, and 5 s for transcode, which can
take minutes. If it doesn't finish, the job is cancelled (ffmpeg is killed) and the
message's visibility is set to 0, so another worker picks it up at once. The Kubernetes
`terminationGracePeriodSeconds` must exceed `DrainTimeout` (M4).

**Validation.** probe-worker runs `ffprobe` on a presigned GET URL, with no download. It
rejects files with no video stream, an unknown duration, or a duration over 5:00. ffmpeg
errors that mean the input is undecodable become permanent failures; other errors are
retried.

## Verified (2026-11-09)
- Testcontainers (`make test-go-integration`): redelivering a finished transcode message
  publishes a single SUCCEEDED and rewrites no objects; a corrupt upload fails with "The
  file is not a readable video"; an always-failing message is attempted 3 times and lands
  in ElasticMQ's DLQ.
- `docker compose stop transcode-worker` mid-transcode: the worker released the message
  and exited in 6 s; after a restart the job finished on attempt 2 and the video became
  READY.

## Consequences
- Duplicate work is possible in a narrow window: two workers handling the same message at
  once, e.g. after a visibility timeout expires while a heartbeat is failing. Outputs are
  identical, so the result is still correct; it only costs CPU.
- Processed media is publicly readable from the local S3 endpoint (anonymous read on the
  processed bucket only). Production would put it behind CloudFront with signed cookies.
