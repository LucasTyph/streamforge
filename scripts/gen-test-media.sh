#!/usr/bin/env bash
# Generates deterministic test clips with ffmpeg (testsrc2 + sine). No downloads.
# Output: media/ (gitignored). Usage: scripts/gen-test-media.sh [outdir]
set -euo pipefail

# `gen-test-media.sh demo [N]`: N 720p clips of 20-45 s for the autoscaling demo (media/demo).
if [ "${1:-}" = demo ]; then
  n=${2:-20}; mkdir -p media/demo
  for i in $(seq -w 1 "$n"); do
    f=media/demo/demo-$i.mp4
    [ -f "$f" ] && continue
    secs=$(( 20 + (10#$i * 7) % 26 )) # deterministic spread over 20..45 s
    ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=$secs" \
      -f lavfi -i "sine=frequency=$(( 300 + 10#$i * 20 )):sample_rate=48000:duration=$secs" \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest "$f"
    echo "generated $f (${secs}s)"
  done
  exit 0
fi

OUT=${1:-media}
mkdir -p "$OUT"

gen() { # name WxH seconds [audio=1]
  local f="$OUT/$1.mp4"
  [ -f "$f" ] && return
  local audio=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$3" -c:a aac -b:a 96k)
  [ "${4:-1}" = 0 ] && audio=()
  ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=$2:rate=30:duration=$3" "${audio[@]}" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -shortest "$f"
  echo "generated $f"
}

gen clip-360p-10s 640x360 10
gen clip-720p-30s 1280x720 30
gen clip-1080p-20s 1920x1080 20
gen clip-240p-noaudio-5s 320x240 5 0
gen clip-portrait-720x1280-8s 720x1280 8

# 6 minutes: over the 5-minute limit (tiny resolution keeps it small and fast)
[ -f "$OUT/too-long-6min.mp4" ] || {
  ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=160x90:rate=5:duration=360" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$OUT/too-long-6min.mp4"
  echo "generated $OUT/too-long-6min.mp4"
}

# Not a video at all, but named like one (deterministic bytes)
[ -f "$OUT/corrupt.mp4" ] || {
  head -c 2000000 /dev/zero | tr '\0' 'x' > "$OUT/corrupt.mp4"
  echo "generated $OUT/corrupt.mp4"
}
