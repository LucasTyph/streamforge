# Measured results

Only numbers from real, reproducible runs go here.

## Upload (M1)
- **Date:** 2026-11-09
- **Hardware:** Windows 11, WSL2 Ubuntu 24.04 (6 vCPU, 10 GB), Docker Desktop 29.9.3
- **Command:** `UPLOAD_TEST_MB=100 make test-integration`
- **What it measures:** the API-side presigned multipart flow over localhost (Node `fetch`, all 13 parts in parallel, 8 MiB parts, SeaweedFS 4.53). Not browser throughput.
- **Raw output:** `uploaded 100.0 MB in 13 parts, 527 ms`

Single run over loopback: treat it as a functional check, not a benchmark.
