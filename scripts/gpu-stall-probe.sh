#!/usr/bin/env bash
#
# Dev-only GPU stall harness for the capture service (docs/determinism.md, failure
# catalogue). Never in CI, gates or release. It drives ONE test instance of the app on a
# private bridge folder and a throwaway workspace root, and prints what it measured:
#
#   A  kb debug lose-context, then a capture: recycle latency, recycles, last reason
#   B  kill -9 the instance's com.apple.WebKit.GPU process, then a capture
#   C  kill -STOP the GPU process, capture (does a fresh window's context block or come
#      up lost?), kill -CONT, capture again (does the next recycle recover?)
#   D  spawn 17 WebGL contexts in the render window (dev builds only): which one WebKit
#      evicts, and whether the census reads it as an eviction
#
# Launch mode (A, B, C; D needs a dev build):
#   scripts/gpu-stall-probe.sh --app "/path/Kookaburra Cut.app" [--scenario A|B|C|D|all]
# Attach mode (a test instance you started yourself, for example a dev build:
#   KOOKABURRA_BRIDGE=1 KOOKABURRA_BRIDGE_DIR=/tmp/kc-stall/_bridge \
#   KOOKABURRA_WORKSPACE_ROOT=/tmp/kc-stall/root pnpm tauri dev):
#   scripts/gpu-stall-probe.sh --pid PID --bridge /tmp/kc-stall/_bridge [--gpu-pid PID]
#
# Safety: the target is the pid whose heartbeat sits in the PRIVATE bridge folder; the
# real ~/Kookaburra Cut/_bridge is refused, and so is any instance on the production
# bundle id with its own workspace. The GPU process is only signalled when it is the one
# new com.apple.WebKit.GPU process that appeared after the test app's first capture (or
# --gpu-pid names it); anything ambiguous skips B and C. Only the launched app is killed.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KB="$REPO/.agents/skills/kookaburra-scene-authoring/scripts/kb.py"
APP=""
PID=""
BRIDGE=""
GPU_PID=""
SCENARIO="all"
CAPTURE_PROJECT="${CAPTURE_PROJECT:-showcase-tour}"
WORK=""
LAUNCHED=""

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --pid) PID="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --gpu-pid) GPU_PID="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'gpu-stall-probe: %s\n' "$*" >&2; exit 2; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
gpu_pids() { pgrep -f 'com.apple.WebKit.GPU' 2>/dev/null | sort || true; }

cleanup() {
  if [ -n "$LAUNCHED" ] && kill -0 "$LAUNCHED" 2>/dev/null; then
    kill "$LAUNCHED" 2>/dev/null || true
    sleep 2
    kill -9 "$LAUNCHED" 2>/dev/null || true
  fi
  if [ -n "$GPU_PID" ]; then kill -CONT "$GPU_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

real_bridge="$HOME/Kookaburra Cut/_bridge"

if [ -n "$APP" ]; then
  [ -z "$PID" ] || fail "pass --app or --pid, not both"
  exe="$APP"
  if [ -d "$APP" ]; then exe="$APP/Contents/MacOS/kookaburra-cut"; fi
  [ -x "$exe" ] || fail "no app executable at $exe"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/kc-stall.XXXXXX")"
  BRIDGE="$WORK/_bridge"
  mkdir -p "$BRIDGE" "$WORK/root"
else
  [ -n "$PID" ] && [ -n "$BRIDGE" ] || fail "attach mode needs --pid and --bridge (or pass --app)"
fi

case "$BRIDGE" in /*) ;; *) fail "--bridge must be an absolute path" ;; esac
if [ -d "$real_bridge" ] && [ "$(cd "$BRIDGE" 2>/dev/null && pwd -P)" = "$(cd "$real_bridge" && pwd -P)" ]; then
  fail "refusing the real bridge folder ($real_bridge); give the test instance a private KOOKABURRA_BRIDGE_DIR"
fi

heartbeat_field() {
  python3 - "$BRIDGE/apps/$1.json" "$2" <<'PY'
import json, sys
try:
    body = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
value = body
for key in sys.argv[2].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else (json.dumps(value) if isinstance(value, (dict, list, bool)) else value))
PY
}

wait_heartbeat() {
  local _
  for _ in $(seq 1 120); do
    if [ "$(heartbeat_field "$1" bridge.serving 2>/dev/null || true)" = "true" ]; then return 0; fi
    sleep 1
  done
  fail "pid $1 never wrote a serving heartbeat in $BRIDGE/apps"
}

GPU_BEFORE="$(gpu_pids)"
if [ -n "$APP" ]; then
  KOOKABURRA_BRIDGE=1 KOOKABURRA_BRIDGE_DIR="$BRIDGE" KOOKABURRA_WORKSPACE_ROOT="$WORK/root" \
    "$exe" >"$WORK/app.log" 2>&1 &
  LAUNCHED=$!
  PID=$LAUNCHED
  say "launched test instance pid $PID (bridge $BRIDGE, root $WORK/root, log $WORK/app.log)"
fi
wait_heartbeat "$PID"
ROOT="$(heartbeat_field "$PID" workspaceRoot)"
BUNDLE="$(heartbeat_field "$PID" bundleId)"
SOURCE="$(heartbeat_field "$PID" rootSource)"
if [ "$BUNDLE" = "com.mpalmes.kookaburracut" ] && [ "$SOURCE" != "env" ]; then
  fail "pid $PID is the production app on its own workspace; the harness only drives test instances"
fi
[ -n "$ROOT" ] && [ -d "$ROOT" ] || fail "pid $PID has no workspace root"

PROJECT="$ROOT/stall-probe"
mkdir -p "$PROJECT/scenes"
[ -f "$PROJECT/project.json" ] || printf '%s\n' '{ "id": "stall-probe", "name": "Stall probe", "version": 2, "themeId": "kookaburra-default", "formats": ["16:9"], "scenes": [] }' >"$PROJECT/project.json"

kb() { (cd "$PROJECT" && KB_BRIDGE_DIR="$BRIDGE" python3 -I "$KB" "$@"); }

health() { heartbeat_field "$PID" "health.$1"; }

timed_capture() {
  local label="$1" started ended code
  shift
  started="$(now_ms)"
  set +e
  kb capture --project "$CAPTURE_PROJECT" --scene 0 --no-copy --json "$@" >"$WORK_OUT/$label.json" 2>"$WORK_OUT/$label.err"
  code=$?
  set -e
  ended="$(now_ms)"
  say "  $label: exit $code after $(( (ended - started) / 1000 )).$(( (ended - started) % 1000 / 100 )) s ($(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("code") or ("ok " + str(d.get("size")))) ' "$WORK_OUT/$label.json" 2>/dev/null || echo "no JSON"))"
}

state_line() {
  sleep 3
  say "  health: recycles $(health renderWindow.recycles), last $(health renderWindow.lastRecycle), gpu $(health gpu), render alive $(health renderWindow.alive), editor contexts $(health webgl.editor)"
}

WORK_OUT="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/kc-stall-out.XXXXXX")}"
say "target: pid $PID ($BUNDLE), root $ROOT, capturing $CAPTURE_PROJECT"
say "warm-up:"
timed_capture warmup

if [ -z "$GPU_PID" ]; then
  new="$(comm -13 <(printf '%s\n' "$GPU_BEFORE") <(gpu_pids) | sed '/^$/d')"
  if [ -n "$APP" ] && [ "$(printf '%s\n' "$new" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ]; then
    GPU_PID="$new"
    say "the test instance's GPU process: pid $GPU_PID (the one new com.apple.WebKit.GPU)"
  else
    say "no unambiguous GPU process for the test instance (new: ${new:-none}); B and C are skipped (pass --gpu-pid)"
  fi
fi

run() { [ "$SCENARIO" = "all" ] || [ "$SCENARIO" = "$1" ]; }

if run A; then
  say "A: lose-context then capture"
  kb debug lose-context --json >"$WORK_OUT/A-lose.json" 2>&1 || true
  timed_capture A
  state_line
fi

if run B && [ -n "$GPU_PID" ]; then
  say "B: kill -9 the GPU process ($GPU_PID)"
  kill -9 "$GPU_PID"
  timed_capture B
  state_line
  GPU_PID="$(comm -13 <(printf '%s\n' "$GPU_BEFORE") <(gpu_pids) | sed '/^$/d' | head -1)"
  say "  WebKit's replacement GPU process: ${GPU_PID:-none yet}"
fi

if run C && [ -n "$GPU_PID" ]; then
  say "C: kill -STOP the GPU process ($GPU_PID) for 90 s"
  kill -STOP "$GPU_PID"
  (timed_capture C-stopped --timeout 150) &
  capture_job=$!
  for t in 15 30 45 60 75 90; do
    sleep 15
    say "  +${t}s: beat age $(health renderWindow.beatAgeMs) ms, in flight $(health queue.inFlight), gpu $(health gpu)"
  done
  kill -CONT "$GPU_PID"
  say "  resumed the GPU process"
  wait "$capture_job" || true
  timed_capture C-resumed
  state_line
  say "  GPU processes now: $(gpu_pids | tr '\n' ' ')"
fi

if run D; then
  say "D: spawn 17 contexts in the render window (dev builds only)"
  (cd "$PROJECT" && KB_BRIDGE_DIR="$BRIDGE" python3 -I -c '
import json, sys
sys.path.insert(0, sys.argv[1])
from kblib import bridge
try:
    resp = bridge.request("debug", {"op": "spawn-contexts", "n": 17}, 60, "gpu-stall-probe")
except Exception as e:
    print("  spawn-contexts failed:", e)
    sys.exit(0)
census = resp.get("census") or {}
lost = [c for c in census.get("contexts") or [] if c.get("lost")]
print("  created", resp.get("created"), "| evictions", census.get("evictions"), "| GPU losses", census.get("gpuLosses"))
for c in lost:
    print("  lost:", c.get("owner"), c.get("api"), c.get("lossClass"))
' "$(dirname "$KB")") || true
  state_line
fi

say "done; raw answers in $WORK_OUT"
