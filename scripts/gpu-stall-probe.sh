#!/usr/bin/env bash
#
# Dev-only GPU stall harness for the capture service (docs/determinism.md, failure
# catalogue). Never in CI, gates or release. It drives ONE test instance of the app on a
# private bridge folder and a throwaway workspace root, and prints what it measured:
#
#   A  kb debug lose-context, then a capture: recycle latency, recycles, last reason
#   B  kill -9 the instance's com.apple.WebKit.GPU process, then a capture
#   C  kill -STOP the GPU process for 90 s, capture, kill -CONT, capture again: every
#      recycle (the silent-window watchdog's included) and whether the GPU wedged
#   D  spawn 17 WebGL contexts in the render window (dev builds only): which one WebKit
#      evicts, and whether the census reads it as an eviction
#
# Each scenario ends with one "X verdict:" line. C passes when the capture after the
# resume works, or when silent windows recycle until the GPU wedges and kb exits 2
# (gpu-wedged); a capture that timed out while the GPU never wedged fails it.
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
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
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

# Sets CAPTURE_EXIT, CAPTURE_CODE (kb's envelope code, or ok) and CAPTURE_SECS.
timed_capture() {
  local label="$1" started ended code
  shift
  started="$(now_ms)"
  set +e
  kb capture --project "$CAPTURE_PROJECT" --scene 0 --no-copy --json "$@" >"$WORK_OUT/$label.json" 2>"$WORK_OUT/$label.err"
  code=$?
  set -e
  ended="$(now_ms)"
  CAPTURE_EXIT=$code
  CAPTURE_CODE="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("code") or "ok")' "$WORK_OUT/$label.json" 2>/dev/null || echo "no-json")"
  CAPTURE_SECS="$(( (ended - started) / 1000 )).$(( (ended - started) % 1000 / 100 ))"
  say "  $label: exit $code after $CAPTURE_SECS s ($CAPTURE_CODE)"
  if grep -q 'restarting its render window' "$WORK_OUT/$label.err" 2>/dev/null; then
    say "  $label: kb said $(grep 'restarting its render window' "$WORK_OUT/$label.err" | tail -1)"
  fi
}

verdict() { say "$1 verdict: $2"; }

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

# Appends each new lastRecycle (and the moment the GPU wedges) to $1 every second until $2 exists.
watch_recycles() {
  python3 - "$BRIDGE/apps/$PID.json" "$1" "$2" "$(health renderWindow.lastRecycle.atMs)" <<'PY' &
import json, os, sys, time
hb, out, stop, seen = sys.argv[1:5]
wedged = False
while not os.path.exists(stop):
    try:
        h = json.load(open(hb)).get("health") or {}
    except Exception:
        h = {}
    rw, gpu = h.get("renderWindow") or {}, h.get("gpu") or {}
    last = rw.get("lastRecycle")
    rows = []
    if isinstance(last, dict) and str(last.get("atMs")) != seen:
        seen = str(last.get("atMs"))
        rows.append({"atMs": last.get("atMs"), "reason": last.get("reason"), "recycles": rw.get("recycles"), "stallsLast10Min": gpu.get("stallsLast10Min")})
    if gpu.get("wedged") and not wedged:
        wedged = True
        rows.append({"atMs": int(time.time() * 1000), "reason": "wedged"})
    with open(out, "a") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    time.sleep(1)
PY
  WATCHER=$!
}

recycle_count() { grep -c "\"reason\": \"$2\"" "$1" 2>/dev/null || true; }

if run A; then
  say "A: lose-context then capture"
  kb debug lose-context --json >"$WORK_OUT/A-lose.json" 2>&1 || true
  timed_capture A
  state_line
  if [ "$CAPTURE_EXIT" = 0 ]; then
    verdict A "PASS recovered in $CAPTURE_SECS s (recycles $(health renderWindow.recycles), last $(health renderWindow.lastRecycle.reason))"
  else
    verdict A "FAIL the capture after lose-context exited $CAPTURE_EXIT ($CAPTURE_CODE)"
  fi
fi

if run B && [ -n "$GPU_PID" ]; then
  say "B: kill -9 the GPU process ($GPU_PID)"
  kill -9 "$GPU_PID"
  timed_capture B
  state_line
  GPU_PID="$(comm -13 <(printf '%s\n' "$GPU_BEFORE") <(gpu_pids) | sed '/^$/d' | head -1)"
  say "  WebKit's replacement GPU process: ${GPU_PID:-none yet}"
  if [ "$CAPTURE_EXIT" = 0 ]; then
    verdict B "PASS recovered in $CAPTURE_SECS s through a fresh window (last recycle $(health renderWindow.lastRecycle.reason))"
  else
    verdict B "FAIL the capture after the kill exited $CAPTURE_EXIT ($CAPTURE_CODE)"
  fi
elif run B; then
  verdict B "SKIP no unambiguous GPU process"
fi

if run C && [ -n "$GPU_PID" ]; then
  say "C: kill -STOP the GPU process ($GPU_PID) for 90 s"
  recycles="$WORK_OUT/C-recycles.jsonl"
  : >"$recycles"
  rm -f "$WORK_OUT/C-stop"
  watch_recycles "$recycles" "$WORK_OUT/C-stop"
  kill -STOP "$GPU_PID"
  (timed_capture C-stopped --timeout 150; echo "$CAPTURE_EXIT $CAPTURE_CODE" >"$WORK_OUT/C-stopped.code") &
  capture_job=$!
  for t in 15 30 45 60 75 90; do
    sleep 15
    say "  +${t}s: beat age $(health renderWindow.beatAgeMs) ms, restarting $(health renderWindow.restarting), recycles $(health renderWindow.recycles) (last $(health renderWindow.lastRecycle.reason)), in flight $(health queue.inFlight), gpu $(health gpu)"
  done
  kill -CONT "$GPU_PID"
  say "  resumed the GPU process"
  wait "$capture_job" || true
  timed_capture C-resumed --timeout 240
  resumed_exit=$CAPTURE_EXIT
  resumed_code=$CAPTURE_CODE
  for _ in $(seq 1 36); do
    [ "$(health gpu.wedged)" = "true" ] && break
    if [ "$(health renderWindow.restarting)" = "false" ] && [ "$(health renderWindow.alive)" = "true" ]; then break; fi
    sleep 5
  done
  sleep 2
  : >"$WORK_OUT/C-stop"
  wait "$WATCHER" 2>/dev/null || true
  state_line
  say "  GPU processes now: $(gpu_pids | tr '\n' ' ')"
  while read -r row; do say "  recycle: $row"; done <"$recycles"
  silent="$(recycle_count "$recycles" silent)"
  wedged="$(health gpu.wedged)"
  stopped="$(cat "$WORK_OUT/C-stopped.code" 2>/dev/null || echo "? unknown")"
  say "  silent-window recycles: ${silent:-0}; GPU wedged: ${wedged:-unknown}; stopped capture: $stopped; resumed capture: $resumed_exit ($resumed_code)"
  if [ "$resumed_exit" = 0 ]; then
    verdict C "PASS recovered after the resume (${silent:-0} silent-window recycles)"
  elif [ "$wedged" = "true" ] && [ "$resumed_code" = "gpu-wedged" ]; then
    verdict C "PASS wedged as designed after ${silent:-0} silent-window recycles; kb exited 2 (gpu-wedged: ask the user to quit and reopen)"
  elif [ "$wedged" != "true" ] && { [ "$resumed_code" = "bridge-timeout" ] || [ "${stopped#* }" = "bridge-timeout" ]; }; then
    verdict C "FAIL a silent window stayed alive: kb timed out and the GPU never wedged"
  else
    verdict C "CHECK the resumed capture exited $resumed_exit ($resumed_code), GPU wedged ${wedged:-unknown}"
  fi
elif run C; then
  verdict C "SKIP no unambiguous GPU process"
fi

if run D && [ "$(health gpu.wedged)" = "true" ]; then
  verdict D "SKIP the GPU is wedged (run D on a fresh instance)"
elif run D; then
  say "D: spawn 17 contexts in the render window (dev builds only)"
  (cd "$PROJECT" && KB_BRIDGE_DIR="$BRIDGE" python3 -I -c '
import json, sys
sys.path.insert(0, sys.argv[1])
from kblib import bridge
try:
    resp = bridge.request("debug", {"op": "spawn-contexts", "n": 17}, 60, "gpu-stall-probe")
except Exception as e:
    print("  spawn-contexts failed:", e)
    print("D verdict: FAIL spawn-contexts failed (dev builds only)")
    sys.exit(0)
census = resp.get("census") or {}
lost = [c for c in census.get("contexts") or [] if c.get("lost")]
print("  created", resp.get("created"), "| evictions", census.get("evictions"), "| GPU losses", census.get("gpuLosses"))
for c in lost:
    print("  lost:", c.get("owner"), c.get("api"), c.get("lossClass"))
if (census.get("evictions") or 0) >= 1 and not census.get("gpuLosses"):
    print("D verdict: PASS the census read", census.get("evictions"), "eviction(s) and no GPU loss")
else:
    print("D verdict: CHECK evictions", census.get("evictions"), "GPU losses", census.get("gpuLosses"))
' "$(dirname "$KB")") || true
  state_line
fi

say "done; raw answers in $WORK_OUT"
