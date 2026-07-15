#!/usr/bin/env bash
#
# Terminal-triggered auto-run of Kookaburra Cut's Verify ×2 / export (AFK-friendly). Sets the
# KOOKABURRA_* env the app reads on boot via the native get_autorun_config (see
# src/engine/autorun.ts), launches `pnpm tauri dev` — which auto-runs the SAME
# export/verify the buttons call — then waits for the native side to write the result
# file, prints it, and exits with a pass/fail code.
#
#   pnpm kookaburra:run --action verify --project launch-2026 --aspect all
#   pnpm kookaburra:run --action export --project device-spike --aspect 16:9 --codec libx264
#   pnpm kookaburra:run --action theme-previews          # regenerate src/assets/theme-previews/
#   pnpm kookaburra:run --action option-previews         # regenerate src/assets/option-previews/
#
# Flags:  --action verify|export|theme-previews|option-previews (required)
#         --project <id>           (default: the app's default project; theme-previews →
#                  theme-starter, option-previews → preview-lab)
#         --aspect 16:9|9:16|1:1|all (default: all)
#         --codec  libx264|h264_videotoolbox|prores_ks (default: libx264)
#         --preset <id>  export through a bundled/user export preset (v11 · M7);
#                  without --aspect, the preset's favoured aspect is used
#         --encode-json <path>  a fully-resolved EncodeSpec JSON (custom encodes)
#         --app    <path/to/Kookaburra Cut.app>  run the PACKAGED app instead of `pnpm tauri dev`
#                  (v9 · M2 — the packaged determinism gate; no dev server, no port 1420)
# Env:    KOOKABURRA_RUN_TIMEOUT  seconds to wait for a result (default 1200)
#
# Exit codes: 0 = ok · 1 = ran but not ok (non-deterministic / run error) · 2 = setup/timeout.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="aarch64-apple-darwin"
SIDECAR="$ROOT/src-tauri/bin/ffmpeg-$TRIPLE"
RESULT_DIR="$HOME/Kookaburra Cut/_autorun"
RESULT_FILE="$RESULT_DIR/last-run.json"
DEV_LOG="$RESULT_DIR/dev.log"
# 2400s default: an occluded/locked-display run used to throttle to a crawl (see
# backgroundThrottling in tauri.conf.json); even with throttling disabled, AFK margin is cheap.
TIMEOUT="${KOOKABURRA_RUN_TIMEOUT:-2400}"

ACTION="" PROJECT="" ASPECT="all" CODEC="libx264" APP="" ASPECT_EXPLICIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --action)  ACTION="${2:-}";  shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --aspect) ASPECT="${2:-}"; ASPECT_EXPLICIT=1; shift 2 ;;
    --codec)  CODEC="${2:-}";  shift 2 ;;
    --preset) PRESET="${2:-}"; shift 2 ;;
    --encode-json) ENCODE_JSON="${2:-}"; shift 2 ;;
    --app)    APP="${2:-}";    shift 2 ;;
    *) echo "kookaburra:run: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [[ "$ACTION" != "verify" && "$ACTION" != "export" && "$ACTION" != "theme-previews" && "$ACTION" != "option-previews" ]]; then
  echo "kookaburra:run: --action must be 'verify', 'export', 'theme-previews' or 'option-previews'" >&2
  exit 2
fi
if [[ -n "$APP" ]]; then
  # Packaged mode: the sidecars sit beside the main binary, so resolve it from
  # Info.plist rather than guessing (a bare find can pick up ffmpeg instead).
  APP_EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  APP_BIN="$APP/Contents/MacOS/$APP_EXEC"
  if [[ -z "$APP_EXEC" || ! -x "$APP_BIN" ]]; then
    echo "kookaburra:run: no executable found inside '$APP' (CFBundleExecutable='${APP_EXEC:-unreadable}')" >&2
    exit 2
  fi
elif [[ ! -x "$SIDECAR" ]]; then
  echo "kookaburra:run: ffmpeg sidecar missing at $SIDECAR" >&2
  echo "            run 'pnpm setup:ffmpeg' first." >&2
  exit 2
fi
# Workspace projects (v6, "ws:<slug>") resolve inside the app against the configured
# workspace — only bundled projects can be pre-validated against the repo tree here.
if [[ -n "$PROJECT" && "$PROJECT" != ws:* && ! -f "$ROOT/projects/$PROJECT/project.json" ]]; then
  echo "kookaburra:run: project '$PROJECT' not found at projects/$PROJECT/project.json" >&2
  echo "            available: $(ls -1 "$ROOT/projects" 2>/dev/null | tr '\n' ' ')" >&2
  exit 2
fi
# One app instance at a time: dev mode needs Vite's port 1420 to itself, and ANY concurrent
# instance (dev or packaged) shares $APPDATA caches with this run. Fail fast with
# guidance instead of a buried stack trace or a cache race.
if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "kookaburra:run: port 1420 is already in use — another 'pnpm tauri dev' is running." >&2
  echo "            stop it first." >&2
  exit 2
fi
if pgrep -f "Kookaburra Cut.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "kookaburra:run: a packaged Kookaburra Cut is already running — quit it first (shared caches)." >&2
  exit 2
fi

mkdir -p "$RESULT_DIR"
rm -f "$RESULT_FILE"
# A fresh option-preview batch must not inherit frames from a previous (longer) run —
# the encoder consumes the whole contiguous %03d sequence in each set directory.
if [[ "$ACTION" == "option-previews" ]]; then
  rm -rf "$RESULT_DIR/option-previews"
fi
# Same for theme previews: the promotion loop copies EVERY staged dir, so stale dirs from
# renamed or removed themes would be resurrected into src/assets on each run.
if [[ "$ACTION" == "theme-previews" ]]; then
  rm -rf "$RESULT_DIR/theme-previews"
fi

# KOOKABURRA_* is the canonical runtime channel (v9 · M2 — read by the native
# get_autorun_config).
export KOOKABURRA_ACTION="$ACTION"
export KOOKABURRA_PROJECT="$PROJECT"
# --preset without an explicit --aspect: leave KOOKABURRA_ASPECT unset so the app uses
# the preset's favoured aspect (the wrapper's "all" default would override it).
if [ -n "${PRESET:-}" ] && [ "$ASPECT_EXPLICIT" != "1" ]; then
  unset KOOKABURRA_ASPECT 2>/dev/null || true
else
  export KOOKABURRA_ASPECT="$ASPECT"
fi
export KOOKABURRA_CODEC="$CODEC"
[ -n "${PRESET:-}" ] && export KOOKABURRA_PRESET="$PRESET"
[ -n "${ENCODE_JSON:-}" ] && export KOOKABURRA_ENCODE_JSON="$(cat "$ENCODE_JSON")"

echo "kookaburra:run: $ACTION  project='${PROJECT:-<default>}'  aspect='$ASPECT'  codec='$CODEC'  ${APP:+app='$APP'  }(timeout ${TIMEOUT}s)"
echo "kookaburra:run: dev log → $DEV_LOG"

# Recursively kill the dev process tree (pnpm → cargo → app → vite). On the happy path the
# app self-exits (app.exit) and this is a no-op backstop; on a hang/timeout it's the teardown.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

# Launch the app in the background; it auto-runs and writes $RESULT_FILE before self-exiting.
# caffeinate: an AFK run must survive display/system sleep — WKWebView suspends rAF (and
# throttles timers) for occluded/sleeping content, which stalled runs before the fix in
# App.tsx/autorun.ts; keeping the display awake avoids the whole throttling class.
# Packaged mode execs the .app binary directly (env inherits; `open` would drop it).
if [[ -n "$APP" ]]; then
  caffeinate -dimsu "$APP_BIN" >"$DEV_LOG" 2>&1 &
else
  caffeinate -dimsu pnpm tauri dev >"$DEV_LOG" 2>&1 &
fi
DEV_PID=$!
trap 'kill_tree "$DEV_PID"' EXIT INT TERM

# Poll for the result file (the source of truth — independent of dev-process exit semantics).
elapsed=0
while [[ ! -f "$RESULT_FILE" ]]; do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    # Dev process exited without a result → build/crash before the auto-run finished.
    echo "kookaburra:run: dev process exited before writing a result — last log lines:" >&2
    tail -n 25 "$DEV_LOG" >&2 || true
    exit 2
  fi
  if [[ "$elapsed" -ge "$TIMEOUT" ]]; then
    echo "kookaburra:run: timed out after ${TIMEOUT}s with no result — see $DEV_LOG" >&2
    exit 2
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "----- kookaburra:run result -----"
cat "$RESULT_FILE"
echo
# `"ok": true` (2-space-indented JSON) ⇒ pass; anything else ⇒ fail.
if ! grep -q '"ok": true' "$RESULT_FILE"; then
  exit 1
fi

# theme-previews: promote the batch into the repo so the bundled previews can be committed
# (the app writes only under ~/Kookaburra Cut — the repo copy is deliberately the wrapper's job).
if [[ "$ACTION" == "theme-previews" ]]; then
  SRC="$RESULT_DIR/theme-previews"
  DEST="$ROOT/src/assets/theme-previews"
  mkdir -p "$DEST"
  copied=0
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    theme="$(basename "$dir")"
    for i in 1 2 3 4; do
      if [[ -f "$dir/$i.jpg" ]]; then
        cp "$dir/$i.jpg" "$DEST/$theme-$i.jpg"
        copied=$((copied + 1))
      fi
    done
  done
  echo "kookaburra:run: copied $copied preview(s) → src/assets/theme-previews/"
fi

# option-previews: encode clip sets (frame sequences → small H.264 loops via the
# sidecar) + promote stills/posters into the repo for commit (v13 · M5 live round).
# Single-frame sets are stills (<set>.jpg); multi-frame sets become <set>.mp4 at
# 20fps (OPTION_CLIP_FPS in engine/optionPreviews.ts) + a middle-frame poster.
if [[ "$ACTION" == "option-previews" ]]; then
  SRC="$RESULT_DIR/option-previews"
  DEST="$ROOT/src/assets/option-previews"
  mkdir -p "$DEST"
  sets=0
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    set_name="$(basename "$dir")"
    frames=("$dir"/*.jpg)
    count=${#frames[@]}
    if [[ "$count" -eq 1 ]]; then
      cp "${frames[0]}" "$DEST/$set_name.jpg"
    else
      middle="${frames[$(((count - 1) / 2))]}"
      cp "$middle" "$DEST/$set_name-poster.jpg"
      "$SIDECAR" -y -hide_banner -loglevel error \
        -framerate 20 -i "$dir/%03d.jpg" \
        -c:v libx264 -pix_fmt yuv420p -crf 24 -an -movflags +faststart \
        "$DEST/$set_name.mp4"
    fi
    sets=$((sets + 1))
  done
  echo "kookaburra:run: promoted $sets option-preview set(s) → src/assets/option-previews/"
fi
exit 0
