# Measured results

Only numbers from real, reproducible runs go here.

## Upload (M1)
- **Date:** 2026-11-09
- **Hardware:** Windows 11, WSL2 Ubuntu 24.04 (6 vCPU, 10 GB), Docker Desktop 29.9.3
- **Command:** `UPLOAD_TEST_MB=100 make test-integration`
- **What it measures:** the API-side presigned multipart flow over localhost (Node `fetch`, all 13 parts in parallel, 8 MiB parts, SeaweedFS 4.53). Not browser throughput.
- **Raw output:** `uploaded 100.0 MB in 13 parts, 527 ms`

Single run over loopback: treat it as a functional check, not a benchmark.

## Pipeline end to end (M2)
- **Date:** 2026-11-09
- **Hardware:** as above; dev stack via `make dev`, one probe-worker and one transcode-worker (2 CPUs, 1 GiB limit)
- **Command:** `node scripts/upload-videos.mjs --expect READY media/clip-*.mp4` (5 clips uploaded at once), then `--expect FAILED media/corrupt.mp4 media/too-long-6min.mp4`
- **Raw output** (time from upload complete to READY/FAILED; the clips queue behind one transcode worker, so later clips include waiting time):
```
ok   clip-360p-10s.mp4                READY    2.2s  640x360 10.0s variants=[360p/index.m3u8] segments(360p/index.m3u8)=3
ok   clip-720p-30s.mp4                READY   28.5s  1280x720 30.0s variants=[360p/index.m3u8, 720p/index.m3u8] segments(360p/index.m3u8)=8
ok   clip-1080p-20s.mp4               READY   42.4s  1920x1080 20.0s variants=[360p/index.m3u8, 720p/index.m3u8] segments(360p/index.m3u8)=5
ok   clip-240p-noaudio-5s.mp4         READY    3.2s  320x240 5.0s variants=[240p/index.m3u8] segments(240p/index.m3u8)=2
ok   clip-portrait-720x1280-8s.mp4    READY    9.3s  720x1280 8.0s variants=[360p/index.m3u8, 720p/index.m3u8] segments(360p/index.m3u8)=2
ok   corrupt.mp4                      FAILED   1.0s  reason="The file is not a readable video"
ok   too-long-6min.mp4                FAILED   1.0s  reason="Video is 6:00 long; the limit is 5:00"
```
Single run. These are functional timings, not a throughput benchmark (that's M7).

## Memory snapshot (M2, idle after the run above)
`docker stats --no-stream`: seaweedfs 480 MiB (limit raised 512 -> 768 MiB), postgres 44 MiB,
elasticmq 32 MiB, redis 15 MiB, sns-shim 7.6 MiB, probe-worker 7.4 MiB, transcode-worker 5.5 MiB
(idle; peak during transcoding not measured yet, planned for M4/M6).

## Image sizes (M4)
- **Date:** 2026-11-09. **Command:** `docker images` after `make images` (uncompressed, as reported by Docker).
```
catalog-api        233MB
probe-worker       156MB
progress-svc       11.9MB
sns-shim           13MB
terraform-local    334MB
thumbnail-worker   156MB
transcode-worker   156MB
web                218MB
```
Most of catalog-api/web is the distroless Node 26 base. The terraform-local image went
from 963 MB to 334 MB after switching from an unpacked provider in `.terraform/` plus
init leftovers to a zipped filesystem mirror.

## Resource usage on k3d (M4, `make up-lite`, idle after the e2e run)
- **Command:** `kubectl top pods -n streamforge` and `kubectl top nodes`
```
NAME                       CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)   
k3d-streamforge-agent-0    81m          1%       382Mi           3%          
k3d-streamforge-agent-1    98m          1%       774Mi           7%          
k3d-streamforge-server-0   292m         4%       1713Mi          17%         

NAME                                CPU(cores)   MEMORY(bytes)   
catalog-api-79cd84c7c6-pn452        23m          76Mi            
catalog-api-79cd84c7c6-rtjn4        23m          68Mi            
elasticmq-8675c5f977-xvzqk          26m          78Mi            
probe-worker-6b7c84b69b-l7ndk       49m          67Mi            
progress-svc-5645fc78fb-52djn       2m           4Mi             
redis-0                             3m           8Mi             
seaweedfs-0                         51m          114Mi           
sns-shim-0                          2m           7Mi             
streamforge-pg-1                    9m           68Mi            
thumbnail-worker-66ffd47cc5-bjj67   35m          10Mi            
transcode-worker-546488895b-qqtsb   1m           10Mi            
web-7944976586-nmbzc                14m          47Mi            
web-7944976586-rg6sp                14m          46Mi            

NAME                                  CPU(cores)   MEMORY(bytes)   
cnpg-cloudnative-pg-859cbd5cd-msshl   4m           33Mi
```

## Playwright e2e against k3d (M4)
- **Command:** `E2E_BASE_URL=http://streamforge.localhost make test-e2e`
```
✓  1 [chromium] › e2e/upload-play.spec.ts:25:1 › upload a clip, watch it process, and play it (8.7s)
  ✓  2 [chromium] › e2e/upload-play.spec.ts:51:1 › a corrupt upload ends FAILED with a readable reason (1.2s)
  2 passed (13.4s)
```

## GitOps loop (M5)
- **Date:** 2026-11-10. **Setup:** GitHub-hosted runners (ci, release); local k3d with ArgoCD 3.6.1 (chart 10.17.1), app reconciliation every 60 s.
- **What was measured:** time from `git push` of commit `38cc69c` (catalog-api change) until
  `http://staging.streamforge.localhost/api/healthz` returned `"version":"38cc69c"`, polled every 10 s.
- **Path:** release.yml built catalog-api (amd64 + arm64) -> GHCR `:38cc69c` -> bot commit
  `b88e93c` bumping `deploy/gitops/staging/images.yaml` -> ArgoCD sync -> rollout.
- **Raw output:** `push->staging serving new build: 208s (+ ~20s before this started)`, so about **228 s**.
- **Observed during rollout:** one request returned `Gateway Timeout` (single replica, no preStop delay).

Single run; GitHub runner queue time varies.

## Autoscaling demo (M6)
- **Date:** 2026-11-10. **Setup:** `make up` on k3d (1 server + 2 agents) in WSL2 (10 GB, 6 vCPU), full observability stack running.
- **Command:** `make demo` equivalent with a sampler: `scripts/scaling-timeline.sh` (queue depth from Prometheus, ready replicas from Kubernetes, every 5 s) while `node scripts/upload-videos.mjs --expect READY media/demo/*.mp4` uploads 20 generated 720p clips of 20-45 s (585 MB total; 5 uploads at a time, 4 parts each).
- **Result:** `20` of 20 READY, `demo exit=0 seconds=186` (first upload to last video READY). An earlier identical run took 196 s.
- **Scaling:** workers went 0 -> probe 1, transcode 4 (max), thumbnail 3 (max) within ~20 s of the first upload; the transcode queue peaked at 20 and drained by t=212 s; every worker was back to 0 replicas at t=264 s.

Timeline (every 3rd sample; queue = visible + in flight):
```
t_seconds  probe_queue  transcode_queue  thumbnail_queue  probe_workers  transcode_workers  thumbnail_workers
0          0            0                0                0              0                  0
17         0            0                0                0              0                  0
36         3            20               20               1              3                  3
56         0            19               12               1              4                  3
76         0            18               9                1              4                  3
96         0            17               3                0              4                  3
115        0            14               0                0              4                  3
138        0            12               0                0              4                  2
159        0            8                0                0              4                  0
177        0            5                0                0              4                  0
195        0            4                0                0              4                  0
212        0            0                0                0              4                  0
229        0            0                0                0              4                  0
247        0            0                0                0              3                  0
264        0            0                0                0              0                  0
280        0            0                0                0              0                  0
297        0            0                0                0              0                  0
```

Peak working set during the run (`max_over_time` of `container_memory_working_set_bytes`):
seaweedfs 896 MiB, transcode-worker 319-353 MiB each (x4), thumbnail-worker 111-145 MiB, catalog-api 134-138 MiB (the HPA ran 3 replicas during the upload burst), probe-worker 30 MiB.
Per namespace: streamforge 3045 MiB, monitoring 2568 MiB, kube-system 368 MiB, keda 292 MiB, cnpg-system 80 MiB.

**Budget note:** during the burst the WSL VM used ~8.8 GB of its 10 GB, Windows had ~0.6 GB free, and WSL briefly stopped answering commands (it recovered and the run completed). Idle with everything running: nodes 2.0 / 1.8 / 3.0 GiB; namespaces streamforge 691 MiB, monitoring 2377 MiB, keda 237 MiB, kube-system 242 MiB, cnpg-system 62 MiB; WSL `free` used 4.7 GB.

**Failures found by this demo** (fixed, ADR-007): SeaweedFS OOM-killed by the burst (concurrent-upload caps + `GOMEMLIMIT`); Grafana OOM-killed at 256 MiB and GC-thrashing at a 400 MiB `GOMEMLIMIT`; catalog-api sending SQS calls to the queue URL host (`localhost`) instead of the configured endpoint.

## Tracing and alerting checks (M6)
- One video = one trace: 31 spans across catalog-api, probe-worker, transcode-worker and thumbnail-worker (ffprobe 213 ms, ffmpeg transcode 14.2 s, thumbnails 6.2 s, 6 status events applied); Loki held 12 log lines from the same 4 services carrying that trace id.
- `StreamForgeDLQNotEmpty`: one message put on the thumbnail DLQ -> alert `firing` after 81 s (1 m `for` + scrape/evaluation) and active in Alertmanager; after purging the DLQ it returned to `inactive` within 30 s.

## Load, benchmark and chaos (M7, 2026-11-11)
Setup: `make up` on k3d in WSL2 (10 GB, 6 vCPU), observability running. Single runs.

**k6 API load** (`make load`, list + detail, 4 API replicas): 50 req/s for 2 min: 5,997 requests, 0 failed, p95 12.3 ms (6 dropped iterations during one 1.45 s spike). 200 req/s for 1 min: 12,003 requests, 0 failed, p95 10.9 ms, 0 dropped.

**k6 upload burst** (`make loadtest-upload`): 10 users each uploading a 25.5 MB clip at once (255 MB, presigned multipart): all complete in 4.9 s, 0 failed requests.

**Batch benchmark** (`make benchmark`, 20 clips of 20-45 s 720p, 585 MB, uploads 5 at a time; time-to-ready = upload complete -> READY):
```
workers  videos  total_s   videos/min  p50_s     p95_s     extra_attempts
1        20/20   305.5     3.93        70.1      81.1      3
2        20/20   202       5.94        45.2      56.2      1
4        20/20   228.9     5.24        48.2      86.7      2
```
Going from 1 to 2 transcode workers cut total time by 34%. 4 workers gave no further gain on this machine: four parallel ffmpeg jobs saturate the 6 vCPUs (average transcode 13 s alone vs 30 s with four in parallel). Other 4-worker runs took 186-196 s.

Before the worker fix in ADR-003 (amendment), the same benchmark gave 302.8 / 328.0 / 196.2 s total and p95 124 / 178 / 77 s: messages handed to dying workers stayed hidden for 60-120 s.

**Chaos** (`make chaos`, a random worker pod killed every 12 s, alternating graceful and hard, during a 20-clip batch):
- Run 1 (before the DLQ watcher): 40 kills in ~8 min; 18/20 READY; 2 transcode messages were killed on all 3 receives and dead-lettered, leaving their videos in PROCESSING. With the watcher deployed they were marked FAILED with a reason within 30 s; a redrive moved both and they were READY 45 s later.
- Run 2 (final code): 28 kills (14 hard, 14 graceful); 20/20 READY in 392 s without a redrive; 14 jobs needed more than one attempt; 0 integrity problems (every HLS variant: ENDLIST, all segments present, durations add up); 0 dead-lettered messages. `CHAOS PASS`.
