"""Synthetic recordings built with lavfi at test time (never committed media), cached per run (KB_VIDEO_SYNTH_DIR keeps them), plus pure stand-ins."""

from __future__ import annotations

import atexit
import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

REPO_BIN = Path(__file__).resolve().parents[5] / "src-tauri" / "bin"
BUNDLED = Path("/Applications/Kookaburra Cut.app/Contents/MacOS")
NEEDED_FILTERS = ("freezedetect", "scdet", "tblend", "cropdetect", "tile", "drawgrid", "testsrc2", "signalstats", "blackdetect")

_DIR: Optional[Path] = None
_TOOLS: Optional[Tuple[str, str]] = None
_SEARCHED = False
_LOCKS: Dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def tools() -> Optional[Tuple[str, str]]:
    """(ffmpeg, ffprobe): the installed app's bundle first, then the repo's dev sidecar, then PATH."""
    global _TOOLS, _SEARCHED
    if _SEARCHED:
        return _TOOLS
    _SEARCHED = True
    candidates: List[Tuple[Optional[str], Optional[str]]] = [
        (str(BUNDLED / "ffmpeg"), str(BUNDLED / "ffprobe")),
        (str(REPO_BIN / "ffmpeg-aarch64-apple-darwin"), str(REPO_BIN / "ffprobe-aarch64-apple-darwin")),
        (shutil.which("ffmpeg"), shutil.which("ffprobe")),
    ]
    for ff, fp in candidates:
        if ff and fp and os.path.isfile(ff) and os.path.isfile(fp) and os.access(ff, os.X_OK) and _has_filters(ff):
            _TOOLS = (ff, fp)
            break
    return _TOOLS


def _has_filters(ffmpeg: str) -> bool:
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    names = {line.split()[1] for line in out.splitlines() if len(line.split()) > 2}
    return all(name in names for name in NEEDED_FILTERS)


def synth_dir() -> Path:
    global _DIR
    if _DIR is None:
        keep = os.environ.get("KB_VIDEO_SYNTH_DIR")
        if keep:
            _DIR = Path(keep)
            _DIR.mkdir(parents=True, exist_ok=True)
        else:
            _DIR = Path(tempfile.mkdtemp(prefix="kb-video-synth-"))
            atexit.register(shutil.rmtree, str(_DIR), True)
    return _DIR


def _run(args: List[str]) -> None:
    proc = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"fixture ffmpeg failed: {proc.stderr[-1500:]}")


def _built(stem: str, ext: str, args: List[str]) -> Path:
    """synth_dir()/<stem>-<hash of the ffmpeg args>.<ext>, built once per run (and per generator change) even when threads race."""
    key = hashlib.sha256("\0".join(args).encode("utf-8")).hexdigest()[:10]
    out = synth_dir() / f"{stem}-{key}.{ext}"
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(str(out), threading.Lock())
    with lock:
        if not out.is_file():
            part = out.with_name(f"{out.stem}.{os.getpid()}.part.{ext}")
            _run(args + [str(part)])
            os.replace(part, out)
    return out


def prebuild() -> None:
    """Builds every recording at once (screen-cfr and screen-vfr wait on the one screen master)."""
    if tools() is None:
        return
    in_parallel({f.__name__: f for f in (screen_vfr, screen_cfr, camera_cfr, counter_cfr)})


def in_parallel(jobs: Dict[str, Callable[[], Any]]) -> Dict[str, Any]:
    """Runs each job in its own thread (they wait on ffmpeg); a job's exception comes back as its result."""
    results: Dict[str, Any] = {}

    def run(name: str, job: Callable[[], Any]) -> None:
        try:
            results[name] = job()
        except Exception as e:
            results[name] = e

    threads = [threading.Thread(target=run, args=item, daemon=True) for item in jobs.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def _require() -> Tuple[str, str]:
    t = tools()
    if t is None:
        raise RuntimeError("no ffmpeg with the analysis filters")
    return t


SCREEN_W, SCREEN_H = 360, 784
TAP_BOX = (230, 280, 40, 40)

# Ground truth for the screen clips: ms, in detect's vocabulary.
SCREEN_TRUTH: Dict[str, object] = {
    "durationMs": 28000,
    "intervals": [
        {"kind": "black", "startMs": 0, "endMs": 600},
        {"kind": "lead-in", "startMs": 600, "endMs": 3400},
        {"kind": "active", "startMs": 3400, "endMs": 4700},
        {"kind": "idle", "sub": "blink", "startMs": 4700, "endMs": 11200},
        {"kind": "idle", "sub": "loading", "startMs": 11200, "endMs": 18000},
        {"kind": "idle", "sub": "static", "startMs": 18000, "endMs": 19000},
        {"kind": "active", "sub": "typing", "startMs": 19000, "endMs": 21750},
        {"kind": "idle", "sub": "static", "startMs": 21750, "endMs": 25000},
        {"kind": "active", "startMs": 25000, "endMs": 25250},
        {"kind": "idle", "sub": "static", "startMs": 25250, "endMs": 26000},
        {"kind": "lead-out", "startMs": 26000, "endMs": 28000},
    ],
    "screenChanges": [18000, 25250, 26000],
    "tap": {"changeMs": 25000, "sourceMs": 24967, "pos": [(230 + 20) / 360, (280 + 20) / 784]},
}


def _screen_graph() -> str:
    typing = "".join(
        f",drawbox=x={30 + 20 * k}:y=612:w=10:h=14:c=white:t=fill:enable='gte(t\\,{19 + 0.25 * k:.2f})'" for k in range(12)
    )
    return ";".join([
        f"color=c=0xE8E8ED:s={SCREEN_W}x{SCREEN_H}:r=60:d=28[base]",
        f"color=c=0x1C1C1E:s={SCREEN_W}x{SCREEN_H}:r=60:d=28[b2]",
        f"color=c=0x0A0A0A:s={SCREEN_W}x{SCREEN_H}:r=60:d=28[dark]",
        "testsrc2=s=360x1600:r=60:d=28[panel]",
        "color=c=0x8E8E93:s=8x8:r=60:d=28[spin]",
        "[base]drawbox=x=0:y=0:w=360:h=90:c=0x3A7BD5:t=fill,drawbox=x=24:y=140:w=312:h=60:c=white:t=fill,"
        "drawbox=x=24:y=220:w=312:h=60:c=white:t=fill[ui]",
        "[ui][panel]overlay=x=0:y='300-(t-3.4)*400':enable='between(t\\,3.4\\,4.69)'[s1]",
        "[s1]drawbox=x=40:y=160:w=2:h=18:c=black:t=fill:enable='between(t\\,4.7\\,11.19)*lt(mod(t-4.7\\,1)\\,0.5)'[s2]",
        "[s2][spin]overlay=x='176+14*cos(9.42*t)':y='396+14*sin(9.42*t)':enable='between(t\\,11.2\\,17.99)'[s3]",
        "[b2]drawbox=x=0:y=0:w=360:h=90:c=0xFF9F0A:t=fill,drawbox=x=24:y=600:w=312:h=50:c=0x2C2C2E:t=fill[ui2]",
        f"[s3][ui2]overlay=enable='gte(t\\,18)'{typing}[s5]",
        "[s5]drawbox=x=230:y=280:w=40:h=40:c=0x8E8E93:t=fill:enable='between(t\\,25\\,25.24)'[s6]",
        "[s6]drawbox=x=0:y=0:w=360:h=784:c=0x34C759:t=fill:enable='between(t\\,25.25\\,25.99)'[s7]",
        "[dark]drawbox=x=160:y=372:w=40:h=40:c=white:t=fill[logo]",
        "[s7][logo]overlay=enable='gte(t\\,26)'[s8]",
        "[s8]drawbox=x=0:y=0:w=360:h=784:c=black:t=fill:enable='lt(t\\,0.59)',format=yuv420p[out]",
    ])


def screen_master() -> Path:
    ff, _ = _require()
    return _built("screen-master", "mp4", [ff, "-v", "error", "-y", "-filter_complex", _screen_graph(), "-map", "[out]", "-c:v", "libx264",
                                           "-preset", "veryfast", "-crf", "16", "-g", "120", "-bf", "0"])


def screen_vfr() -> Path:
    """A Simulator-like recording: a frame per screen change (mpdecimate), timescale 600."""
    ff, _ = _require()
    # tpad + select keep one copy of the final frame at the very end, as a Simulator stop does.
    vf = "trim=end_frame=1679,mpdecimate,tpad=stop_mode=clone:stop=1"
    return _built("screen-vfr", "mov", [ff, "-v", "error", "-y", "-i", str(screen_master()), "-vf", vf, "-fps_mode", "vfr",
                                        "-video_track_timescale", "600", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-bf", "0"])


def screen_cfr() -> Path:
    """The same screen at a constant 30 fps (a QuickTime-like capture)."""
    ff, _ = _require()
    return _built("screen-cfr", "mp4", [ff, "-v", "error", "-y", "-i", str(screen_master()), "-vf", "fps=30", "-c:v", "libx264",
                                        "-preset", "veryfast", "-crf", "16", "-g", "60", "-bf", "0"])


CAMERA_TRUTH = {"durationMs": 12000, "noisyStill": [4000, 8000], "trueFreeze": [8000, 9500]}


def camera_cfr() -> Path:
    """Camera-like: moving noisy footage, a noisy still (never a freeze) and a true freeze."""
    ff, _ = _require()
    graph = ";".join([
        "testsrc2=s=640x360:r=30:d=12,noise=alls=14:allf=t+u[mov]",
        "testsrc2=s=640x360:r=30:d=12,trim=end_frame=1,loop=loop=-1:size=1,setpts=N/30/TB,trim=duration=12,split[st1][st2]",
        "[st1]noise=alls=14:allf=t+u[sn]",
        "[mov][sn]overlay=enable='between(t\\,4\\,7.99)'[a]",
        "[a][st2]overlay=enable='between(t\\,8\\,9.49)',format=yuv420p[out]",
    ])
    return _built("camera-cfr", "mp4", [ff, "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast",
                                        "-crf", "14", "-g", "30", "-bf", "0", "-t", "12"])


def counter_cfr(seconds: int = 12, fps: int = 30) -> Path:
    """Each frame paints its own number as twelve black/white bars (readable back without drawtext)."""
    ff, _ = _require()
    bits = "+".join(f"gte(mod(floor(N/{1 << i})\\,2)\\,1)*gte(X\\,{i * 20})*lt(X\\,{i * 20 + 20})" for i in range(12))
    graph = (f"color=c=black:s=240x120:r={fps}:d={seconds},format=gray,"
             f"geq=lum='if(lt(Y\\,60)\\,255*({bits})\\,128)',format=yuv420p[out]")
    return _built(f"counter-{seconds}s-{fps}", "mp4", [ff, "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264",
                                                       "-preset", "veryfast", "-qp", "0", "-g", "300", "-bf", "0"])


# ── pure stand-ins (no ffmpeg) ───────────────────────────────────────────────

CONFIDENCE = {"black": 0.98, "lead-in": 0.99, "lead-out": 0.95, "static": 0.99, "blink": 0.9, "loading": 0.8}


def screen_analysis() -> Dict[str, object]:
    """detect.analyse's output for screen-vfr.mov, written out (the ffmpeg test pins the real one to it)."""
    intervals = []
    for n, iv in enumerate(SCREEN_TRUTH["intervals"], 1):  # type: ignore[arg-type]
        sub = iv.get("sub", "static" if iv["kind"] in ("lead-in", "lead-out") else None)
        conf = 1.0 if iv["kind"] == "active" else CONFIDENCE.get(iv["kind"] if iv["kind"] != "idle" else sub, 0.95)
        if iv["kind"] == "lead-out":
            conf = 0.95
        intervals.append({"id": f"i{n}", "kind": iv["kind"], "sub": sub, "startMs": iv["startMs"], "endMs": iv["endMs"],
                          "exactStartMs": float(iv["startMs"]), "exactEndMs": float(iv["endMs"]), "confidence": conf, "note": ""})
    tap = SCREEN_TRUTH["tap"]
    return {
        "profile": "screen", "durationMs": 28000, "vfr": True, "editFps": 60.0, "width": 360, "height": 784,
        "intervals": intervals,
        "screenChanges": [{"tMs": 600.0, "score": 75, "fromBlack": True}] + [
            {"tMs": float(t), "score": 40, "fromBlack": False} for t in (3400, 4700, 18000, 25250, 26000)],
        "tapCandidates": [{"id": "k1", "kind": "tap-candidate", "tMs": 25000.0, "sourceMs": tap["sourceMs"], "pos": tap["pos"],  # type: ignore[index]
                           "confidence": 0.95, "followedBy": "screen change"}],
        "activity": [],
    }


def screen_doc(**extra: object) -> Dict[str, object]:
    doc: Dict[str, object] = {
        "version": 1, "name": "sim-checkout",
        "sources": [{"id": "s1", "rel": "assets/sim-checkout.mov", "kind": "video", "width": 360, "height": 784, "fps": 18.5, "durationMs": 28000}],
        "settings": {"width": 360, "height": 784, "fps": 60},
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 28000, "speed": 1, "startMs": 0}],
        "taps": [], "masks": [],
    }
    doc.update(extra)
    return doc


KINDS = [("idle", "static"), ("idle", "blink"), ("idle", "loading"), ("active", None), ("active", "typing"), ("black", None)]


def random_analysis(rng: "object", duration: int) -> Dict[str, object]:
    """A plausible partition of [0, duration) into intervals, with screen changes and tap candidates at activity."""
    t = 0
    intervals: List[Dict[str, object]] = []
    changes = []
    taps = []
    while t < duration:
        length = min(duration - t, rng.randint(150, 4000))  # type: ignore[attr-defined]
        kind, sub = KINDS[rng.randrange(len(KINDS))]  # type: ignore[attr-defined]
        if intervals and intervals[-1]["kind"] == kind and intervals[-1]["sub"] == sub:
            kind, sub = ("active", None) if kind != "active" else ("idle", "static")
        conf = 1.0 if kind == "active" else round(rng.uniform(0.55, 0.99), 2)  # type: ignore[attr-defined]
        intervals.append({"id": "", "kind": kind, "sub": sub, "startMs": t, "endMs": t + length,
                          "exactStartMs": float(t), "exactEndMs": float(t + length), "confidence": conf, "note": ""})
        if kind == "active" and rng.random() < 0.5:  # type: ignore[attr-defined]
            changes.append({"tMs": float(t), "score": 30, "fromBlack": False})
        if kind == "active" and sub is None and rng.random() < 0.3 and length > 300:  # type: ignore[attr-defined]
            taps.append({"id": f"k{len(taps) + 1}", "kind": "tap-candidate", "tMs": float(t), "sourceMs": t,
                         "pos": [rng.random(), rng.random()], "confidence": round(rng.uniform(0.5, 0.95), 2)})  # type: ignore[attr-defined]
        t += length
    idle = [i for i, iv in enumerate(intervals) if iv["kind"] == "idle" and iv["sub"] == "static"]
    if idle and idle[0] == 0:
        intervals[0]["kind"] = "lead-in"
    if idle and idle[-1] == len(intervals) - 1 and len(intervals) > 1:
        intervals[-1]["kind"] = "lead-out"
    for n, iv in enumerate(intervals, 1):
        iv["id"] = f"i{n}"
    return {"profile": "screen", "durationMs": duration, "intervals": intervals, "screenChanges": changes, "tapCandidates": taps, "activity": []}


def random_doc(rng: "object", sources: int = 1) -> Tuple[Dict[str, object], Dict[str, Dict[str, object]]]:
    """A doc of 1-5 clips over 1-2 sources (some retimed, some freezes), with taps, plus each source's analysis."""
    srcs, analyses = [], {}
    for i in range(sources):
        dur = rng.randint(4000, 40000)  # type: ignore[attr-defined]
        sid = f"s{i + 1}"
        srcs.append({"id": sid, "rel": f"assets/rec{i + 1}.mov", "kind": "video", "width": 390, "height": 844, "fps": 60, "durationMs": dur})
        analyses[sid] = random_analysis(rng, dur)
    clips = []
    for n in range(rng.randint(1, 5)):  # type: ignore[attr-defined]
        src = srcs[rng.randrange(len(srcs))]  # type: ignore[attr-defined]
        dur = src["durationMs"]
        a = rng.randint(0, max(0, dur - 1000))  # type: ignore[attr-defined]
        b = rng.randint(a + 600, dur) if a + 600 < dur else dur  # type: ignore[attr-defined]
        if rng.random() < 0.12:  # type: ignore[attr-defined]
            clips.append({"id": f"c{n + 1}", "sourceId": src["id"], "inMs": a, "outMs": a, "speed": 1, "holdMs": rng.randint(100, 2500), "startMs": 0})  # type: ignore[attr-defined]
            continue
        speed = 1 if rng.random() < 0.75 else rng.choice([0.5, 1.5, 2, 4])  # type: ignore[attr-defined]
        clips.append({"id": f"c{n + 1}", "sourceId": src["id"], "inMs": a, "outMs": b, "speed": speed, "startMs": 0})
    taps = []
    for n in range(rng.randint(0, 3)):  # type: ignore[attr-defined]
        c = clips[rng.randrange(len(clips))]  # type: ignore[attr-defined]
        if c.get("holdMs") is None and c["outMs"] - c["inMs"] > 50:
            taps.append({"id": f"t{n + 1}", "sourceId": c["sourceId"], "sourceMs": rng.randint(c["inMs"], c["outMs"] - 1), "pos": [0.5, 0.5]})  # type: ignore[attr-defined]
    doc = {"version": 1, "name": "rand", "sources": srcs, "settings": {"width": 390, "height": 844, "fps": rng.choice([30, 60])},  # type: ignore[attr-defined]
           "clips": clips, "taps": taps, "masks": []}
    return doc, analyses
