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
#   pnpm kookaburra:run --action theme-previews          # regenerate stale theme previews
#   pnpm kookaburra:run --action preset-previews         # regenerate src/assets/preset-previews/
#   pnpm kookaburra:run --action option-previews         # regenerate src/assets/option-previews/
#   pnpm kookaburra:run --action render-spike --at 300   # hidden render window throttling spike
#
# Multi-worktree safe (v13): runs never need port 1420, so an interactive `pnpm tauri dev`
# keeps running untouched.
#   · PORT   each dev run picks its own free port (scripts/dev-port.mjs) and passes the
#            matching devUrl + dev CSP through `tauri dev -c`; KOOKABURRA_PORT drives vite.
#   · QUEUE  runs take a FIFO ticket in ~/Kookaburra Cut/_autorun/queue and wait their turn
#            instead of failing fast, so parallel agents serialise rather than collide.
#   · RESULT each run owns ~/Kookaburra Cut/_autorun/runs/<run-id>/ (KOOKABURRA_RESULT_DIR),
#            so queued runs never clobber each other. last-run.json is copied back to the
#            legacy ~/Kookaburra Cut/_autorun/last-run.json and dev.log is symlinked there.
#
# Flags:  --action verify|export|theme-previews|template-previews|preset-previews|option-previews|perf|screenshot|packroundtrip|create|render-spike (required)
#         --project <id[,id...]>   (default: the app's default project; theme-previews →
#                  preview-lab-theme (incremental via the theme-preview manifest; --all re-records
#                  every theme), option-previews → the preview-lab-* fixtures (incremental
#                  via the src/assets/option-previews/manifest.json diff; --all re-records
#                  everything); preset-previews → every bundled preset slug (comma list);
#                  verify/export accept a
#                  comma list and run every project in ONE app boot, e.g. the gate pair)
#         --aspect 16:9|9:16|1:1|4:5|5:4|3:2|2:3|phone|phone-landscape|all
#                  (default: all = the standing three; perf and screenshot default to 16:9)
#         --scene  <index|stem>    (screenshot: which scene; defaults to its midpoint)
#         --at     <seconds>       (screenshot: seconds into the scene, or the project without --scene;
#                  render-spike: sample duration, default 300)
#         --codec  libx264|h264_videotoolbox|prores_ks (default: libx264)
#         --preset <id>  export through a bundled/user export preset (v11 · M7);
#                  without --aspect, the preset's favoured aspect is used
#         --encode-json <path>  a fully-resolved EncodeSpec JSON (custom encodes)
#         --app    <path/to/Kookaburra Cut.app>  run the PACKAGED app instead of `pnpm tauri dev`
#                  (v9 · M2 — the packaged determinism gate; no dev server, no port)
#         --foreground  launch the app normally instead of in the background (no-focus-steal)
#                  mode; always on for --action perf, which needs an honest visible window
#         --no-wait  don't queue: exit 2 straight away when another run holds the queue
#
#   pnpm kookaburra:run --action create --project blank   # create-from-template smoke in a
#                  throwaway workspace root; pass --app to prove the packaged resource layout
# Env:    KOOKABURRA_RUN_TIMEOUT    seconds to wait for a result (default 2400)
#         KOOKABURRA_QUEUE_TIMEOUT  seconds to wait for the queue (default 1800)
#
# Exit codes: 0 = ok · 1 = ran but not ok (non-deterministic / run error) · 2 = setup/timeout.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="aarch64-apple-darwin"
SIDECAR="$ROOT/src-tauri/bin/ffmpeg-$TRIPLE"
# The autorun home is FIXED: never the (possibly throwaway) KOOKABURRA_WORKSPACE_ROOT, so
# queue tickets and run dirs from every worktree land in the one place.
AUTORUN_DIR="$HOME/Kookaburra Cut/_autorun"
QUEUE_DIR="$AUTORUN_DIR/queue"
RUNS_DIR="$AUTORUN_DIR/runs"
RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$RUNS_DIR/$RUN_ID"
RESULT_FILE="$RUN_DIR/last-run.json"
LEGACY_RESULT="$AUTORUN_DIR/last-run.json"
DEV_LOG="$RUN_DIR/dev.log"
# 2400s default: an occluded/locked-display run used to throttle to a crawl (see
# backgroundThrottling in tauri.conf.json); even with throttling disabled, AFK margin is cheap.
TIMEOUT="${KOOKABURRA_RUN_TIMEOUT:-2400}"
QUEUE_TIMEOUT="${KOOKABURRA_QUEUE_TIMEOUT:-1800}"
KEEP_RUNS=20
TICKET=""

ACTION="" PROJECT="" ASPECT="all" CODEC="libx264" APP="" ASPECT_EXPLICIT=0 ALL_PREVIEWS=0
FOREGROUND=0 NO_WAIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --action)  ACTION="${2:-}";  shift 2 ;;
    --all)     ALL_PREVIEWS=1;   shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --aspect) ASPECT="${2:-}"; ASPECT_EXPLICIT=1; shift 2 ;;
    --codec)  CODEC="${2:-}";  shift 2 ;;
    --preset) PRESET="${2:-}"; shift 2 ;;
    --encode-json) ENCODE_JSON="${2:-}"; shift 2 ;;
    --scene)  SCENE="${2:-}";  shift 2 ;;
    --at)     AT="${2:-}";     shift 2 ;;
    --app)    APP="${2:-}";    shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    --no-wait)    NO_WAIT=1;    shift ;;
    *) echo "kookaburra:run: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [[ "$ACTION" != "verify" && "$ACTION" != "export" && "$ACTION" != "theme-previews" && "$ACTION" != "template-previews" && "$ACTION" != "preset-previews" && "$ACTION" != "option-previews" && "$ACTION" != "perf" && "$ACTION" != "screenshot" && "$ACTION" != "packroundtrip" && "$ACTION" != "create" && "$ACTION" != "render-spike" ]]; then
  echo "kookaburra:run: --action must be 'verify', 'export', 'theme-previews', 'template-previews', 'preset-previews', 'option-previews', 'perf', 'screenshot', 'packroundtrip', 'create' or 'render-spike'" >&2
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
# Bundled projects ship from projects/; the dev-only gate spikes and preview labs live in
# fixtures/ and load by the same bare id (dev builds only, see engine/project.ts).
if [[ -n "$PROJECT" && "$ACTION" != "preset-previews" ]]; then
  IFS=',' read -ra PROJECT_LIST <<<"$PROJECT"
  for P in "${PROJECT_LIST[@]}"; do
    # Library ids resolve their scoped tree here; workspace-side scopes resolve in the app.
    case "$P" in
      template:*) P="${P#template:}" ;;
      preset:*)
        if [[ ! -f "$ROOT/presets/${P#preset:}/preset.json" ]]; then
          echo "kookaburra:run: preset '${P#preset:}' not found at presets/${P#preset:}/preset.json" >&2
          exit 2
        fi
        continue
        ;;
      ws-template:* | ws-preset:*) continue ;;
    esac
    if [[ -n "$P" && "$P" != ws:* && ! -f "$ROOT/projects/$P/project.json" && ! -f "$ROOT/fixtures/$P/project.json" ]]; then
      echo "kookaburra:run: project '$P' not found at projects/$P/project.json or fixtures/$P/project.json" >&2
      echo "            available: $( (ls -1 "$ROOT/projects"; ls -1 "$ROOT/fixtures") 2>/dev/null | tr '\n' ' ')" >&2
      exit 2
    fi
  done
fi
# A packaged instance still shares $APPDATA caches with this run in an unmanaged way (it
# takes no queue ticket and no per-run result dir), so that one stays a hard fail.
if pgrep -f "Kookaburra Cut.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "kookaburra:run: a packaged Kookaburra Cut is already running — quit it first (shared caches)." >&2
  exit 2
fi
# The perf probe measures this machine's spare capacity, so an app running alongside skews
# every number. It still runs (the operator may have judged it harmless), just warned.
if [[ "$ACTION" == "perf" ]]; then
  FOREGROUND=1
  if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "kookaburra:run: warning: something is already serving port 1420, which pollutes the fps numbers" >&2
  fi
fi

echo "kookaburra:run: $ACTION  project='${PROJECT:-<default>}'  aspect='$ASPECT'  codec='$CODEC'  ${APP:+app='$APP'  }(timeout ${TIMEOUT}s)"
echo "kookaburra:run: run dir → $RUN_DIR"

# Recursively kill the dev process tree (pnpm → cargo → app → vite). On the happy path the
# app self-exits (app.exit) and this is a no-op backstop; on a hang/timeout it's the teardown.
# Never walks anything but our own tree: other runs' processes are theirs to reap.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ -n "${DEV_PID:-}" ]]; then kill_tree "$DEV_PID"; fi
  if [[ -n "${TICKET:-}" ]]; then rm -f "$TICKET"; fi
}
trap cleanup EXIT INT TERM

# One field out of a one-line ticket JSON.
ticket_field() {
  sed -n 's/.*"'"$2"'": *"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' "$1" 2>/dev/null || true
}

# Tickets are named <epoch>-<pid>.json, so the sorted glob IS the queue order.
front_ticket() {
  local f
  for f in "$QUEUE_DIR"/*.json; do
    if [[ -e "$f" ]]; then printf '%s' "$f"; return 0; fi
  done
  return 0
}

# A run killed mid-flight can't clear its own ticket; its pid dying is the release signal.
drop_dead_tickets() {
  local f pid
  for f in "$QUEUE_DIR"/*.json; do
    [[ -e "$f" ]] || continue
    pid="$(ticket_field "$f" pid)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then rm -f "$f"; fi
  done
}

queue_position() {
  local f count=0
  for f in "$QUEUE_DIR"/*.json; do
    [[ -e "$f" ]] || continue
    count=$((count + 1))
    if [[ "$f" == "$TICKET" ]]; then break; fi
  done
  printf '%d' "$count"
}

write_ticket() {
  printf '{"pid":%d,"action":"%s","project":"%s","worktree":"%s","started":"%s"}\n' \
    "$$" "$ACTION" "$PROJECT" "$ROOT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TICKET"
}

# FIFO across every worktree: write a ticket, then wait until it is the oldest live one.
mkdir -p "$QUEUE_DIR"
TICKET="$QUEUE_DIR/$(printf '%012d' "$(date -u +%s)")-$$.json"
write_ticket
waited=0
next_notice=0
while :; do
  drop_dead_tickets
  if [[ ! -f "$TICKET" ]]; then write_ticket; fi
  FRONT="$(front_ticket)"
  if [[ "$FRONT" == "$TICKET" ]]; then break; fi
  if [[ "$NO_WAIT" == "1" ]]; then
    echo "kookaburra:run: another run holds the queue and --no-wait was given" >&2
    echo "            front: $(ticket_field "$FRONT" action) $(ticket_field "$FRONT" project) in $(ticket_field "$FRONT" worktree) (pid $(ticket_field "$FRONT" pid))" >&2
    exit 2
  fi
  if [[ "$waited" -ge "$QUEUE_TIMEOUT" ]]; then
    echo "kookaburra:run: gave up waiting for the queue after ${QUEUE_TIMEOUT}s" >&2
    echo "            front: $(ticket_field "$FRONT" action) $(ticket_field "$FRONT" project) in $(ticket_field "$FRONT" worktree) (pid $(ticket_field "$FRONT" pid))" >&2
    echo "            raise KOOKABURRA_QUEUE_TIMEOUT, or clear $QUEUE_DIR if that run is gone." >&2
    exit 2
  fi
  if [[ "$waited" -ge "$next_notice" ]]; then
    echo "kookaburra:run: queued behind $(ticket_field "$FRONT" action) $(ticket_field "$FRONT" project) in $(ticket_field "$FRONT" worktree) (pid $(ticket_field "$FRONT" pid)), position $(queue_position), waited ${waited}s"
    next_notice=$((waited + 14))
  fi
  sleep 2
  waited=$((waited + 2))
done
if [[ "$waited" -gt 0 ]]; then echo "kookaburra:run: queue acquired after ${waited}s"; fi

mkdir -p "$RUN_DIR"
: >"$DEV_LOG"
# Live tailing keeps working off the one stable path, whichever run is current.
ln -sfn "$RUN_DIR/dev.log" "$AUTORUN_DIR/dev.log"
rm -f "$LEGACY_RESULT"
# Keep the last few runs for post-mortems; the rest are dead weight (frames, logs, roots).
pruned=0
for dir in $(ls -1 "$RUNS_DIR" 2>/dev/null | sort -r); do
  pruned=$((pruned + 1))
  if [[ "$pruned" -gt "$KEEP_RUNS" ]]; then rm -rf "$RUNS_DIR/$dir"; fi
done

# A fresh option-preview batch must not inherit frames from a previous (longer) run —
# the encoder consumes the whole contiguous %03d sequence in each set directory.
# Incremental by default: the manifest diff names the stale sets and the app only mounts
# lab projects owning one; nothing stale skips the boot entirely. --all forces a full
# re-record (deliberate engine-change refreshes, docs/backgrounds.md).
if [[ "$ACTION" == "option-previews" ]]; then
  rm -rf "$RUN_DIR/option-previews"
  if [[ "$ALL_PREVIEWS" != "1" ]]; then
    STALE_SETS="$(node "$ROOT/scripts/option-preview-stale.mjs" list)"
    if [[ -z "$STALE_SETS" ]]; then
      echo "kookaburra:run: option previews are all fresh — nothing to do (--all forces a re-record)"
      exit 0
    fi
    export KOOKABURRA_SETS="$STALE_SETS"
    echo "kookaburra:run: $(echo "$STALE_SETS" | tr ',' '\n' | wc -l | tr -d ' ') stale option-preview set(s) to capture"
  fi
fi
# Same for theme previews: the promotion loop copies EVERY staged dir, so stale dirs from
# renamed or removed themes would be resurrected into src/assets on each run.
if [[ "$ACTION" == "theme-previews" ]]; then
  rm -rf "$RUN_DIR/theme-previews"
  THEME_PREVIEW_PROJECT="${PROJECT:-preview-lab-theme}"
  unset KOOKABURRA_THEMES 2>/dev/null || true
  node "$ROOT/scripts/theme-preview-stale.mjs" cleanup --project "$THEME_PREVIEW_PROJECT"
  if [[ "$ALL_PREVIEWS" != "1" ]]; then
    STALE_THEMES="$(node "$ROOT/scripts/theme-preview-stale.mjs" list --project "$THEME_PREVIEW_PROJECT")"
    if [[ -z "$STALE_THEMES" ]]; then
      echo "kookaburra:run: theme previews are all fresh, nothing to do (--all forces a re-record)"
      exit 0
    fi
    export KOOKABURRA_THEMES="$STALE_THEMES"
    echo "kookaburra:run: $(echo "$STALE_THEMES" | tr ',' '\n' | wc -l | tr -d ' ') stale theme(s) to capture"
  fi
fi

# The pack round trip renders in a THROWAWAY workspace root seeded from the real one, so the
# import lands beside a copy and the user's workspace is never written to. `finish_autorun`
# writes to KOOKABURRA_RESULT_DIR, so the result still lands where we look for it.
if [[ "$ACTION" == "packroundtrip" ]]; then
  if [[ "$PROJECT" != ws:* ]]; then
    echo "kookaburra:run: --action packroundtrip needs a workspace project (ws:<slug>); bundled projects do not live in the workspace" >&2
    exit 2
  fi
  RT_SLUG="${PROJECT#ws:}"
  RT_SRC="$HOME/Kookaburra Cut"
  RT_ROOT="$RUN_DIR/roundtrip-root"
  if [[ ! -d "$RT_SRC/$RT_SLUG" ]]; then
    echo "kookaburra:run: no project at '$RT_SRC/$RT_SLUG'" >&2
    exit 2
  fi
  rm -rf "$RT_ROOT"
  mkdir -p "$RT_ROOT"
  cp -R "$RT_SRC/$RT_SLUG" "$RT_ROOT/$RT_SLUG"
  for shared in themes fonts objects gradients export-presets screenshots; do
    [[ -d "$RT_SRC/$shared" ]] && cp -R "$RT_SRC/$shared" "$RT_ROOT/$shared"
  done
  mkdir -p "$RT_ROOT/_autorun/roundtrip"
  export KOOKABURRA_WORKSPACE_ROOT="$RT_ROOT"
  echo "kookaburra:run: round trip in $RT_ROOT"
fi

# The create smoke lands its project in a THROWAWAY workspace root, so the user's
# workspace is never written to and the seeded _samples are provably fresh.
if [[ "$ACTION" == "create" ]]; then
  if [[ -z "$PROJECT" || "$PROJECT" == ws:* || "$PROJECT" == *,* ]]; then
    echo "kookaburra:run: --action create needs one bundled template id (e.g. --project blank)" >&2
    exit 2
  fi
  if [[ ! -f "$ROOT/projects/$PROJECT/template.json" && -z "$APP" ]]; then
    echo "kookaburra:run: '$PROJECT' has no projects/$PROJECT/template.json, so it is not a template" >&2
    exit 2
  fi
  CREATE_ROOT="$RUN_DIR/create-root"
  rm -rf "$CREATE_ROOT"
  mkdir -p "$CREATE_ROOT"
  export KOOKABURRA_WORKSPACE_ROOT="$CREATE_ROOT"
  echo "kookaburra:run: create smoke in $CREATE_ROOT"
fi

# template-previews materialise into the same throwaway root as the create smoke, so the
# user's workspace is never written to; staged art is cleared so the promotion loop can
# only copy this run's sets. --project selects templates (comma list, default: all).
if [[ "$ACTION" == "template-previews" ]]; then
  if [[ -n "$PROJECT" && -z "$APP" ]]; then
    IFS=',' read -r -a TPL_IDS <<<"$PROJECT"
    for tpl in "${TPL_IDS[@]}"; do
      if [[ ! -f "$ROOT/projects/$tpl/template.json" ]]; then
        echo "kookaburra:run: '$tpl' has no projects/$tpl/template.json, so it is not a template" >&2
        exit 2
      fi
    done
  fi
  rm -rf "$RUN_DIR/template-previews"
  CREATE_ROOT="$RUN_DIR/create-root"
  rm -rf "$CREATE_ROOT"
  mkdir -p "$CREATE_ROOT"
  export KOOKABURRA_WORKSPACE_ROOT="$CREATE_ROOT"
  echo "kookaburra:run: template previews in $CREATE_ROOT"
fi

# preset-previews render the bundled presets/ tree in place (a preset IS a single-scene
# project folder, so nothing is created in a workspace); staged art is cleared so the
# promotion loop can only copy this run's sets. --project selects presets by slug.
if [[ "$ACTION" == "preset-previews" ]]; then
  if [[ -n "$PROJECT" ]]; then
    IFS=',' read -r -a PRESET_IDS <<<"$PROJECT"
    for preset in "${PRESET_IDS[@]}"; do
      if [[ ! -f "$ROOT/presets/$preset/preset.json" ]]; then
        echo "kookaburra:run: '$preset' has no presets/$preset/preset.json, so it is not a preset" >&2
        exit 2
      fi
    done
  elif [[ -z "$(ls -1 "$ROOT"/presets/*/preset.json 2>/dev/null)" ]]; then
    echo "kookaburra:run: no bundled presets in presets/, nothing to capture"
    exit 0
  fi
  rm -rf "$RUN_DIR/preset-previews"
fi

# KOOKABURRA_* is the canonical runtime channel (v9 · M2 — read by the native
# get_autorun_config).
export KOOKABURRA_ACTION="$ACTION"
export KOOKABURRA_PROJECT="$PROJECT"
export KOOKABURRA_RESULT_DIR="$RUN_DIR"
[ "$FOREGROUND" = "1" ] && export KOOKABURRA_FOREGROUND=1
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
[ -n "${SCENE:-}" ] && export KOOKABURRA_SCENE="$SCENE"
[ -n "${AT:-}" ] && export KOOKABURRA_AT="$AT"

# Dev runs never touch 1420: pick a free port and hand tauri the matching devUrl + dev CSP.
pick_port() {
  PORT="$(node "$ROOT/scripts/dev-port.mjs" pick)"
  export KOOKABURRA_PORT="$PORT"
  OVERRIDE="$(node "$ROOT/scripts/dev-port.mjs" override "$PORT")"
}
if [[ -z "$APP" ]]; then
  pick_port
  echo "kookaburra:run: dev server on port $PORT"
fi
echo "kookaburra:run: dev log → $DEV_LOG"

# Launch the app in the background; it auto-runs and writes $RESULT_FILE before self-exiting.
# caffeinate: an AFK run must survive display/system sleep — WKWebView suspends rAF (and
# throttles timers) for occluded/sleeping content, which stalled runs before the fix in
# App.tsx/autorun.ts; keeping the display awake avoids the whole throttling class.
# Packaged mode execs the .app binary directly (env inherits; `open` would drop it).
launch_dev() {
  if [[ -n "$APP" ]]; then
    caffeinate -dimsu "$APP_BIN" >"$DEV_LOG" 2>&1 &
  else
    caffeinate -dimsu pnpm tauri dev -c "$OVERRIDE" >"$DEV_LOG" 2>&1 &
  fi
  DEV_PID=$!
}

# Poll for the result file (the source of truth — independent of dev-process exit semantics).
# 0 = result written · 3 = early death on a taken port (retryable) · 4 = other death · 5 = timeout.
poll_result() {
  local elapsed=0
  while [[ ! -f "$RESULT_FILE" ]]; do
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      if [[ -z "$APP" && "$elapsed" -le 60 ]] &&
        grep -qiE "EADDRINUSE|address already in use|is already in use" "$DEV_LOG"; then
        return 3
      fi
      return 4
    fi
    if [[ "$elapsed" -ge "$TIMEOUT" ]]; then return 5; fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 0
}

attempt=1
while :; do
  launch_dev
  status=0
  poll_result || status=$?
  if [[ "$status" -eq 0 ]]; then break; fi
  kill_tree "$DEV_PID"
  if [[ "$status" -eq 3 && "$attempt" -lt 3 ]]; then
    attempt=$((attempt + 1))
    pick_port
    echo "kookaburra:run: port was taken between the pick and the bind, retrying on $PORT (attempt $attempt/3)" >&2
    continue
  fi
  if [[ "$status" -eq 5 ]]; then
    echo "kookaburra:run: timed out after ${TIMEOUT}s with no result — see $DEV_LOG" >&2
  else
    # Dev process exited without a result → build/crash before the auto-run finished.
    echo "kookaburra:run: dev process exited before writing a result — last log lines:" >&2
    tail -n 25 "$DEV_LOG" >&2 || true
  fi
  exit 2
done

# Other scripts and docs read the legacy path, so every run leaves its result there too.
cp -f "$RESULT_FILE" "$LEGACY_RESULT"

echo "----- kookaburra:run result -----"
cat "$RESULT_FILE"
echo
# `"ok": true` (2-space-indented JSON) ⇒ pass; anything else ⇒ fail.
if ! grep -q '"ok": true' "$RESULT_FILE"; then
  exit 1
fi

# render-spike: the beat statistics live in the result file.
if [[ "$ACTION" == "render-spike" ]]; then
  echo "kookaburra:run: render-spike stats → $RESULT_FILE"
fi

# screenshot: surface the PNG path.
if [[ "$ACTION" == "screenshot" ]]; then
  PNG="$(grep -o '"path": "[^"]*"' "$RESULT_FILE" | head -1 | sed 's/"path": "\(.*\)"/\1/')"
  [[ -n "$PNG" ]] && echo "kookaburra:run: screenshot → $PNG"
fi

# theme-previews: promote the batch into the repo so the bundled previews can be committed
# (the app writes only under ~/Kookaburra Cut — the repo copy is deliberately the wrapper's job).
if [[ "$ACTION" == "theme-previews" ]]; then
  SRC="$RUN_DIR/theme-previews"
  DEST="$ROOT/src/assets/theme-previews"
  mkdir -p "$DEST"
  copied=0
  PROMOTED=()
  # Validate every staged set before changing any final preview or manifest entry.
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    theme="$(basename "$dir")"
    for i in 1 2 3 4; do
      if [[ ! -f "$dir/$i.jpg" ]]; then
        echo "kookaburra:run: incomplete theme preview set for $theme (missing $i.jpg)" >&2
        exit 1
      fi
    done
    PROMOTED+=("$theme")
  done
  if [[ "${#PROMOTED[@]}" -eq 0 ]]; then
    echo "kookaburra:run: no theme preview sets were produced" >&2
    exit 1
  fi
  # Invalidate first, so interruption during the copies can only cause a safe re-render.
  node "$ROOT/scripts/theme-preview-stale.mjs" invalidate --project "$THEME_PREVIEW_PROJECT" "${PROMOTED[@]}"
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    theme="$(basename "$dir")"
    for i in 1 2 3 4; do
      tmp="$DEST/.theme-preview-$theme-$i.tmp"
      cp "$dir/$i.jpg" "$tmp"
      mv -f "$tmp" "$DEST/$theme-$i.jpg"
      copied=$((copied + 1))
    done
  done
  node "$ROOT/scripts/theme-preview-stale.mjs" commit --project "$THEME_PREVIEW_PROJECT" "${PROMOTED[@]}"
  echo "kookaburra:run: promoted $copied preview(s) → src/assets/theme-previews/"
fi

# template-previews: promote the staged card art into the repo (the theme-previews pattern,
# no stale ledger: the action re-renders whatever --project selects).
if [[ "$ACTION" == "template-previews" ]]; then
  SRC="$RUN_DIR/template-previews"
  DEST="$ROOT/src/assets/template-previews"
  mkdir -p "$DEST"
  copied=0
  PROMOTED=()
  # Validate every staged set before changing any final preview.
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    tpl="$(basename "$dir")"
    for i in 1 2 3 4; do
      if [[ ! -f "$dir/$i.jpg" ]]; then
        echo "kookaburra:run: incomplete template preview set for $tpl (missing $i.jpg)" >&2
        exit 1
      fi
    done
    PROMOTED+=("$tpl")
  done
  if [[ "${#PROMOTED[@]}" -eq 0 ]]; then
    echo "kookaburra:run: no template preview sets were produced" >&2
    exit 1
  fi
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    tpl="$(basename "$dir")"
    for i in 1 2 3 4; do
      tmp="$DEST/.template-preview-$tpl-$i.tmp"
      cp "$dir/$i.jpg" "$tmp"
      mv -f "$tmp" "$DEST/$tpl-$i.jpg"
      copied=$((copied + 1))
    done
  done
  node "$ROOT/scripts/preset-preview-stale.mjs" commit template "${PROMOTED[@]}"
  echo "kookaburra:run: promoted $copied preview(s) → src/assets/template-previews/"
fi

# preset-previews: promote the staged card art into the repo (the template-previews block,
# one still per preset: presets/<slug>/preset.json names a single preview frame).
if [[ "$ACTION" == "preset-previews" ]]; then
  SRC="$RUN_DIR/preset-previews"
  DEST="$ROOT/src/assets/preset-previews"
  mkdir -p "$DEST"
  copied=0
  PROMOTED=()
  # Validate every staged set before changing any final preview.
  for dir in "$SRC"/*/; do
    [[ -d "$dir" ]] || continue
    preset="$(basename "$dir")"
    if [[ ! -f "$dir/1.jpg" ]]; then
      echo "kookaburra:run: incomplete preset preview for $preset (missing 1.jpg)" >&2
      exit 1
    fi
    PROMOTED+=("$preset")
  done
  # The run reported ok, so an empty batch means there was nothing to capture, not a failure.
  if [[ "${#PROMOTED[@]}" -eq 0 ]]; then
    echo "kookaburra:run: no preset previews were produced (nothing to capture)"
    exit 0
  fi
  for preset in "${PROMOTED[@]}"; do
    tmp="$DEST/.preset-preview-$preset.tmp"
    cp "$SRC/$preset/1.jpg" "$tmp"
    mv -f "$tmp" "$DEST/$preset.jpg"
    copied=$((copied + 1))
  done
  node "$ROOT/scripts/preset-preview-stale.mjs" commit preset "${PROMOTED[@]}"
  echo "kookaburra:run: promoted $copied preview(s) → src/assets/preset-previews/"
fi

# option-previews: encode clip sets (frame sequences → small H.264 loops via the
# sidecar) + promote stills/posters into the repo for commit (v13 · M5 live round).
# Single-frame sets are stills (<set>.jpg); multi-frame sets become <set>.mp4 at
# 20fps (OPTION_CLIP_FPS in engine/optionPreviews.ts) + a middle-frame poster.
if [[ "$ACTION" == "option-previews" ]]; then
  SRC="$RUN_DIR/option-previews"
  DEST="$ROOT/src/assets/option-previews"
  mkdir -p "$DEST"
  sets=0
  PROMOTED=()
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
    PROMOTED+=("$set_name")
    sets=$((sets + 1))
  done
  # Only promoted sets earn a manifest entry, so a mid-run failure re-records the rest next time.
  if [[ "$sets" -gt 0 ]]; then
    node "$ROOT/scripts/option-preview-stale.mjs" commit "${PROMOTED[@]}"
  fi
  echo "kookaburra:run: promoted $sets option-preview set(s) → src/assets/option-previews/"
fi
exit 0
