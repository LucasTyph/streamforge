# 3-minute demo video: shot list

Record at 1080p with the stack from `make up` already running (start it 5 minutes before,
so everything has settled). Use dark mode and hide bookmarks. Have two browser tabs ready:
the app (http://streamforge.localhost) and Grafana's **StreamForge / Pipeline** dashboard
(http://grafana.streamforge.localhost, time range "Last 15 minutes", refresh 10 s).
Run `make media` once beforehand so `media/` has clips to drag in.

| Time | Screen | What to do | What to say |
|---|---|---|---|
| 0:00-0:15 | App, library | Sign in as the demo user. Library shows a few ready videos. | "StreamForge is an event-driven video pipeline I built to practise Kubernetes, AWS APIs, Terraform and observability. Everything runs locally with one command." |
| 0:15-0:45 | App, upload | Drag `clip-1080p-20s.mp4` onto the drop zone. Point at the per-chunk bars, then open the video card while it processes. | "The browser uploads straight to S3 with presigned multipart URLs. From there it's events: SNS fans out to SQS queues, and Go workers probe, transcode to HLS and cut thumbnails. Progress is live over Server-Sent Events." |
| 0:45-1:05 | App, player | When it turns Ready: play, hover the seek bar for the scrub preview, open the quality menu. | "Adaptive HLS with 360p and 720p renditions, and scrub previews from a sprite sheet." |
| 1:05-1:20 | Terminal | Run `make demo` (20 uploads). Leave it visible for a second. | "Now twenty uploads at once." |
| 1:20-2:00 | Grafana, Pipeline | Switch to the dashboard. Watch queue depth jump and the dashed replica lines climb, then fall back to zero. | "Workers are scaled by KEDA on queue depth, from zero to four transcoders and back to zero when the queue drains. That's the queue, and that's the replica count." |
| 2:00-2:25 | Grafana, trace | In "Recent transcode traces" click a trace ID. Expand the transcode span, then use the logs link. | "Every video is one distributed trace across the API and the workers. The trace context travels in the message attributes, and logs link to the same trace." |
| 2:25-2:45 | App, Ops page | Open Ops: queue depths, DLQ column, Redrive button. | "Failed jobs retry three times, then land in a dead-letter queue I can inspect and redrive. In a chaos test I kill worker pods mid-batch and nothing is lost." |
| 2:45-3:00 | GitHub repo | Show the Actions tab (green runs), then the README results table. | "CI builds multi-arch images, ArgoCD syncs the cluster from git, and the same pipeline is defined in Terraform for real AWS. Measured results and design decisions are in the repo." |

## Tips
- Do one dry run of `make demo` first: the first scale-up after a cold start pulls nothing,
  but Grafana panels look better with some history.
- If the laptop is short on RAM, close other apps: the burst uses most of the 10 GB given to WSL.
- For README GIFs, record the upload-to-ready segment (0:15-1:05) and the Grafana scaling
  panel (1:20-2:00) separately, 10-15 s each, and save them as `docs/img/upload.gif` and
  `docs/img/scaling.gif`.
