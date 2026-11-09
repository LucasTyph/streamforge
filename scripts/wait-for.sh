#!/usr/bin/env bash
# Waits until every given URL answers (any HTTP status), up to 90 s each.
set -euo pipefail
for url in "$@"; do
  for i in $(seq 1 90); do
    if curl -s -o /dev/null --max-time 2 "$url"; then echo "ready: $url"; continue 2; fi
    sleep 1
  done
  echo "timed out waiting for $url" >&2
  exit 1
done
