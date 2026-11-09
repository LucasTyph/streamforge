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
