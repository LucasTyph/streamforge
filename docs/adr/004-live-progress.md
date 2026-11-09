# ADR-004: Live progress over Server-Sent Events

- **Status:** Accepted
- **Date:** 2026-11-09

## Context
The UI must show per-stage progress (probing → transcoding → thumbnails → ready) as it
happens, including transcode percentages parsed from `ffmpeg -progress`. Updates flow one
way (server → browser), are frequent but tiny, and are fine to lose occasionally: the
durable state lives in Postgres.

## Decision
- **Transport: SSE**, not WebSockets. One-way, plain HTTP that works through ingress
  controllers, and the browser's `EventSource` reconnects on its own.
- **Bus: Redis pub/sub**, one channel per *user*: `progress:user:<ownerId>`. Workers
  publish progress (throttled to 2/s per task); catalog-api publishes `{kind:"video"}`
  when a job-status event changes a video's status, and the UI then refetches that video.
- **Routing without a database:** catalog-api puts `ownerId` in `video-uploaded`, and
  probe copies it into `video-probed`, so every worker knows whose channel to publish
  to. progress-svc never queries Postgres.
- **Auth:** progress-svc verifies the same HS256 session JWT (`sf_session` cookie)
  that catalog-api issues, using the shared `JWT_SECRET`. It has no other credentials. A
  user can only subscribe to their own channel, because the channel comes from the
  verified `sub`, never from the request. Streams close when the token expires.
- **Fan-out:** one `PSUBSCRIBE progress:user:*` per progress-svc process and an
  in-memory hub. Publishing never blocks: a slow browser drops progress ticks instead of
  stalling others. Replicas scale horizontally because each one receives every message.
- **Shutdown:** on SIGTERM, `/readyz` returns 503 and each stream closes at its next
  heartbeat (15 s), so browsers reconnect to another replica.
- **Fallback:** if the stream is down, the library polls every 4 s while something is
  processing.

## Consequences
- Progress is best effort: events published while nobody is connected are dropped
  (pub/sub has no history). The page's initial fetch shows the durable state.
- The cookie is shared across ports on `localhost` in dev, and paths on one host behind
  ingress in Kubernetes (M4), so `EventSource({withCredentials: true})` works without
  extra tokens.
- The `PSUBSCRIBE` costs every replica every message. That's fine at this scale; with
  thousands of users we'd shard channels or move to Redis Streams with consumer groups.
