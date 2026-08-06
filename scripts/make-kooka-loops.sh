#!/usr/bin/env bash
# v3 pool loops: ffmpeg xfade over the Kooka stills at their native 828x1792
# (the device screen ratio; the export path only does the fixed aspects, which
# cover-cropped v2 inside handset screens). Plus a fictional terminal loop.
set -euo pipefail
WT="$(cd "$(dirname "$0")/.." && pwd)"
S="$WT/projects/_samples"
FF="$WT/src-tauri/bin/ffmpeg-aarch64-apple-darwin"
T="$(mktemp -d)"
mkdir -p "$T"

# Feed loop: home -> detail -> settings -> light home, 3.2s each, 0.5s fades = 11.3s.
"$FF" -y \
  -loop 1 -t 3.2 -i "$S/shot-a-sample.jpg" \
  -loop 1 -t 3.2 -i "$S/shot-b-sample.jpg" \
  -loop 1 -t 3.2 -i "$S/shot-c-sample.jpg" \
  -loop 1 -t 3.2 -i "$S/home-light-sample.jpg" \
  -filter_complex "[0][1]xfade=transition=fade:duration=0.5:offset=2.7[a];[a][2]xfade=transition=fade:duration=0.5:offset=5.4[b];[b][3]xfade=transition=fade:duration=0.5:offset=8.1,format=yuv420p" \
  -r 30 -c:v libx264 -crf 26 -preset slow -an "$T/feed.mp4" 2> "$T/feed.log"

# Dark loop: dark home -> notifications on -> dark home, 3.0s each = 8.0s.
"$FF" -y \
  -loop 1 -t 3.0 -i "$S/home-dark-sample.jpg" \
  -loop 1 -t 3.0 -i "$S/settings-on-sample.jpg" \
  -loop 1 -t 3.0 -i "$S/home-dark-sample.jpg" \
  -filter_complex "[0][1]xfade=transition=fade:duration=0.5:offset=2.5[a];[a][2]xfade=transition=fade:duration=0.5:offset=5.0,format=yuv420p" \
  -r 30 -c:v libx264 -crf 26 -preset slow -an "$T/dark.mp4" 2> "$T/dark.log"

# Terminal stills: a fictional kooka CLI deploy, three progressive frames.
term() { # term <out> <lines...>
  local out="$1"; shift
  local args=()
  local y=64
  for line in "$@"; do
    args+=(-annotate "+48+$y" "$line")
    y=$((y + 44))
  done
  magick -size 1440x900 xc:'#101114' -fill '#d8dee6' -font /System/Library/Fonts/Monaco.ttf -pointsize 26 "${args[@]}" "$out"
}
term "$T/t1.png" '$ kooka release --minor'
term "$T/t2.png" '$ kooka release --minor' 'kooka 4.2.0: 84 files bundled' 'checks: types ok, tests 212 ok'
term "$T/t3.png" '$ kooka release --minor' 'kooka 4.2.0: 84 files bundled' 'checks: types ok, tests 212 ok' 'signed and notarised' 'shipped to 100% in 4m12s'
"$FF" -y \
  -loop 1 -t 2.6 -i "$T/t1.png" \
  -loop 1 -t 2.6 -i "$T/t2.png" \
  -loop 1 -t 3.0 -i "$T/t3.png" \
  -filter_complex "[0][1]xfade=transition=fade:duration=0.3:offset=2.3[a];[a][2]xfade=transition=fade:duration=0.3:offset=4.6,format=yuv420p" \
  -r 30 -c:v libx264 -crf 24 -preset slow -an "$T/terminal.mp4" 2> "$T/terminal.log"

cp "$T/feed.mp4" "$S/kooka-feed-loop-sample.mp4"
cp "$T/dark.mp4" "$S/kooka-dark-loop-sample.mp4"
cp "$T/terminal.mp4" "$S/kooka-terminal-loop-sample.mp4"
ls -la "$S"/kooka-*.mp4 | awk '{print $5, $9}'
echo "LOOPS_V3_DONE"
