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
