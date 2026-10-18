"""Analysis passes over one recording with the app's ffprobe/ffmpeg: probe, packet gaps, then one decode read from metadata=print log lines (no path ever enters a filter graph)."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError, atomic_write_text

ANALYSIS_VERSION = 1
SCREEN_SHORT_EDGE = 360
CAMERA_SHORT_EDGE = 270
SAMPLE_FPS = 10
# A pixel must move at least this much (0-255) to count: keyframe re-encodes of a still screen stay under it.
CHANGE_YMAX = 24
BBOX_MIN = 16
BLACK_ARGS = "d=0.1:pic_th=0.98:pix_th=0.10"
SCREEN_FREEZE = "n=-68dB:d=0.5"
CAMERA_FLOORS_DB = (-55, -50, -45, -40, -35, -30)
STATIC_GAP_MS = 500.0
DECODE_TIMEOUT_S = 1800

_LOG_RE = re.compile(r"^\[(metadata@[a-z0-9]+) @ 0x[0-9a-f]+\] (.*)$")
_FRAME_RE = re.compile(r"^frame:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:\s*(\S+)")


class Tools:
    __slots__ = ("ffmpeg", "ffprobe")

    def __init__(self, ffmpeg: str, ffprobe: str) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe


def _usable(path: Optional[str]) -> bool:
    return bool(path) and os.path.isfile(str(path)) and os.access(str(path), os.X_OK)


def find_tools() -> Tools:
    """KB_FFMPEG/KB_FFPROBE, then the app CLI's own paths, then the app bundle beside Resources, then PATH."""
    ff, fp = os.environ.get("KB_FFMPEG"), os.environ.get("KB_FFPROBE")
    if _usable(ff) and _usable(fp):
        return Tools(str(ff), str(fp))
    try:
        from . import appcli  # avk-kb; may be absent in a partial kit

        ff, fp = appcli.ffmpeg_path(), appcli.ffprobe_path()
        if _usable(ff) and _usable(fp):
            return Tools(str(ff), str(fp))
    except Exception:  # noqa: BLE001 - an old app or no CLI falls back to the bundle
        pass
    from .. import bridge

    macos = bridge.resources_dir().parent / "MacOS"
    ff, fp = str(macos / "ffmpeg"), str(macos / "ffprobe")
    if _usable(ff) and _usable(fp):
        return Tools(ff, fp)
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if ff and fp:
        return Tools(ff, fp)
    raise KbError("no ffmpeg found: Kookaburra Cut's bundle (Contents/MacOS/ffmpeg) is missing; ask the user to install or update the app", EXIT_ENV)


# ── P0: probe ────────────────────────────────────────────────────────────────


def rust_round(x: float) -> int:
    """f64::round for non-negative values: half away from zero (Python's round() is half-even)."""
    if x <= 0:
        return 0
    f = math.floor(x)
    return int(f + (1 if x - f >= 0.5 else 0))


def parse_rate(text: Any) -> float:
    if not isinstance(text, str) or not text:
        return 0.0
    if "/" in text:
        num, den = text.split("/", 1)
        try:
            return float(num) / float(den) if float(den) else 0.0
        except ValueError:
            return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def is_vfr(r_rate: float, avg_rate: float) -> bool:
    """Mirror of media.rs is_vfr."""
    return r_rate > 0 and avg_rate > 0 and abs(r_rate - avg_rate) > 0.5


def _rotation(stream: Dict[str, Any]) -> int:
    for entry in stream.get("side_data_list") or []:
        if isinstance(entry, dict) and "rotation" in entry:
            try:
                return int(round(float(entry["rotation"])))
            except (TypeError, ValueError):
                pass
    tags = stream.get("tags") or {}
    try:
        return int(round(float(tags.get("rotate", 0))))
    except (TypeError, ValueError):
        return 0


def parse_probe(data: Dict[str, Any]) -> Dict[str, Any]:
    """The editor's view of a file: display size (rotation honoured), rates, VFR flag and the edit fps."""
    streams = [s for s in data.get("streams") or [] if isinstance(s, dict) and s.get("codec_type") == "video"]
    if not streams:
        raise KbError("no video stream in this file", EXIT_PROBLEMS)
    s = streams[0]
    width, height = int(s.get("width") or 0), int(s.get("height") or 0)
    rotation = _rotation(s)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    r_fps = parse_rate(s.get("r_frame_rate"))
    avg_fps = parse_rate(s.get("avg_frame_rate"))
    try:
        duration_ms = rust_round(float((data.get("format") or {}).get("duration") or 0) * 1000)
    except (TypeError, ValueError):
        duration_ms = 0
    vfr = is_vfr(r_fps, avg_fps)
    nb = s.get("nb_frames")
    return {
        "width": width,
        "height": height,
        "rotation": rotation,
        "rFps": round(r_fps, 4),
        "avgFps": round(avg_fps, 4),
        "fps": avg_fps,
        "vfr": vfr,
        "editFps": 60.0 if vfr or avg_fps <= 0 else avg_fps,
        "durationMs": duration_ms,
        "nbFrames": int(nb) if isinstance(nb, str) and nb.isdigit() else None,
        "codec": s.get("codec_name"),
    }


def probe(tools: Tools, path: Path) -> Dict[str, Any]:
    proc = _run([tools.ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)], 60)
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError:
        raise KbError(f"ffprobe gave unreadable output for {path.name}") from None
    return parse_probe(data)


# ── P1: packets ──────────────────────────────────────────────────────────────


def parse_packets(text: str) -> List[float]:
    out: List[float] = []
    for line in text.splitlines():
        head = line.split(",", 1)[0].strip()
        if head and head != "N/A":
            try:
                out.append(float(head) * 1000.0)
            except ValueError:
                continue
    out.sort()
    return out


def packet_gaps(pts_ms: List[float], duration_ms: float, min_gap_ms: float = STATIC_GAP_MS) -> List[Tuple[float, float]]:
    """Holds of at least min_gap between packets (a virtual last packet sits at the container duration)."""
    if not pts_ms:
        return []
    marks = list(pts_ms)
    if duration_ms > marks[-1]:
        marks.append(float(duration_ms))
    return [(a, b) for a, b in zip(marks, marks[1:]) if b - a >= min_gap_ms]


def packets(tools: Tools, path: Path) -> List[float]:
    proc = _run([tools.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags",
                 "-of", "csv=p=0", str(path)], 300)
    return parse_packets(proc.stdout)


# ── P2: one decode ───────────────────────────────────────────────────────────


def scaled_size(width: int, height: int, short_edge: int) -> Tuple[int, int]:
    """Even analysis size with the short edge at most short_edge (never upscaled)."""
    if width <= 0 or height <= 0:
        return (short_edge, short_edge)
    short = min(width, height)
    target = min(short_edge, short)
    k = target / short
    w = max(2, int(round(width * k / 2)) * 2)
    h = max(2, int(round(height * k / 2)) * 2)
    return (w, h)


def decode_graph(sw: int, sh: int) -> str:
    bank = "".join(f"[c{-db}]" for db in CAMERA_FLOORS_DB)
    legs = [
        f"[0:v]scale={sw}:{sh}:flags=area,split=2[a][b]",
        f"[a]fps={SAMPLE_FPS}:start_time=0,split={1 + len(CAMERA_FLOORS_DB)}[a0]{bank}",
        f"[a0]signalstats,blackdetect={BLACK_ARGS},freezedetect={SCREEN_FREEZE},scdet=threshold=10,metadata@pa=mode=print[ao]",
    ]
    for db in CAMERA_FLOORS_DB:
        legs.append(f"[c{-db}]freezedetect=n={db}dB:d=1,metadata@c{-db}=mode=print,nullsink")
    legs.append(
        "[b]format=gray,tblend=all_mode=difference,signalstats,"
        f"metadata=mode=select:key=lavfi.signalstats.YMAX:value={CHANGE_YMAX}:function=greater,"
        f"bbox=min_val={BBOX_MIN},metadata@pb=mode=print,nullsink"
    )
    return ";".join(legs)


def parse_log(lines: Iterable[str]) -> Dict[str, List[Dict[str, Any]]]:
    """metadata=print log lines -> {instance: [{"t": ms, "n": frame, "meta": {key: value}}]}."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for raw in lines:
        m = _LOG_RE.match(raw.rstrip("\n"))
        if not m:
            continue
        inst, body = m.group(1), m.group(2)
        fm = _FRAME_RE.match(body)
        rows = out.setdefault(inst, [])
        if fm:
            try:
                t = float(fm.group(3)) * 1000.0
            except ValueError:
                continue
            rows.append({"t": t, "n": int(fm.group(1)), "meta": {}})
        elif rows and "=" in body:
            key, _, value = body.partition("=")
            rows[-1]["meta"][key.strip()] = value.strip()
    return out


def _num(meta: Dict[str, str], key: str) -> Optional[float]:
    v = meta.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _intervals(rows: List[Dict[str, Any]], start_key: str, end_key: str, duration_ms: float) -> List[List[float]]:
    """Pair *_start/*_end values (seconds) across frames; an open interval runs to the end."""
    out: List[List[float]] = []
    open_at: Optional[float] = None
    for row in rows:
        s = _num(row["meta"], start_key)
        e = _num(row["meta"], end_key)
        if e is not None and open_at is not None:
            out.append([open_at, e * 1000.0])
            open_at = None
        if s is not None:
            open_at = s * 1000.0
    if open_at is not None:
        out.append([open_at, float(duration_ms)])
    return out


def collect(info: Dict[str, Any], pts_ms: List[float], logs: Dict[str, List[Dict[str, Any]]], scaled: Tuple[int, int]) -> Dict[str, Any]:
    """The plain series detect.py works on."""
    duration = float(info.get("durationMs") or 0)
    samples = []
    scd_times: List[float] = []
    rows_a = logs.get("metadata@pa", [])
    for row in rows_a:
        meta = row["meta"]
        samples.append([round(row["t"], 3), _num(meta, "lavfi.signalstats.YAVG") or 0.0, _num(meta, "lavfi.signalstats.YMAX") or 0.0,
                        _num(meta, "lavfi.signalstats.YDIF") or 0.0, _num(meta, "lavfi.scd.score") or 0.0])
        st = _num(meta, "lavfi.scd.time")
        if st is not None:
            scd_times.append(round(st * 1000.0, 3))
    changes = []
    for row in logs.get("metadata@pb", []):
        meta = row["meta"]
        x1, x2 = _num(meta, "lavfi.bbox.x1"), _num(meta, "lavfi.bbox.x2")
        y1, y2 = _num(meta, "lavfi.bbox.y1"), _num(meta, "lavfi.bbox.y2")
        bbox = [int(x1), int(y1), int(x2), int(y2)] if None not in (x1, x2, y1, y2) and x2 >= x1 and y2 >= y1 else None
        changes.append([round(row["t"], 3), _num(meta, "lavfi.signalstats.YAVG") or 0.0, _num(meta, "lavfi.signalstats.YMAX") or 0.0, bbox])
    camera = {}
    for db in CAMERA_FLOORS_DB:
        camera[str(db)] = _intervals(logs.get(f"metadata@c{-db}", []), "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end", duration)
    return {
        "version": ANALYSIS_VERSION,
        "info": info,
        "scaled": list(scaled),
        "packets": [round(p, 3) for p in pts_ms] if info.get("vfr") else [],
        "packetGaps": [[round(a, 3), round(b, 3)] for a, b in packet_gaps(pts_ms, duration)] if info.get("vfr") else [],
        "samples": samples,
        "scd": scd_times,
        "black": _intervals(rows_a, "lavfi.black_start", "lavfi.black_end", duration),
        "freezes": _intervals(rows_a, "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end", duration),
        "cameraFreezes": camera,
        "changes": changes,
    }


def decode(tools: Tools, path: Path, scaled: Tuple[int, int], timeout_s: float = DECODE_TIMEOUT_S) -> Dict[str, List[Dict[str, Any]]]:
    args = [tools.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-v", "repeat+info", "-i", str(path),
            "-filter_complex", decode_graph(*scaled), "-map", "[ao]", "-f", "null", "-"]
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    except OSError as e:
        raise KbError(f"ffmpeg failed to start: {e}", EXIT_ENV) from None
    timer = threading.Timer(timeout_s, proc.kill)
    timer.start()
    tail: List[str] = []
    try:
        assert proc.stderr is not None
        kept = (line for line in _keep_tail(proc.stderr, tail) if line.startswith("[metadata@"))
        logs = parse_log(kept)
        proc.wait()
    finally:
        timer.cancel()
        if proc.stderr is not None:
            proc.stderr.close()
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not decode {path.name}: {' '.join(tail[-3:]).strip()[:400]}")
    return logs


def _keep_tail(stream: Iterable[str], tail: List[str]) -> Iterable[str]:
    for line in stream:
        if not line.startswith("[metadata@"):
            tail.append(line)
            if len(tail) > 20:
                del tail[0]
        yield line


def _run(args: List[str], timeout: float) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, errors="replace")
    except OSError as e:
        raise KbError(f"{Path(args[0]).name} failed to start: {e}", EXIT_ENV) from None
    except subprocess.TimeoutExpired:
        raise KbError(f"{Path(args[0]).name} timed out after {int(timeout)} s", EXIT_ENV) from None
    if proc.returncode != 0:
        raise KbError(f"{Path(args[0]).name} failed: {proc.stderr.strip()[-400:]}")
    return proc


# ── content hash + cache ─────────────────────────────────────────────────────


def file_sha256(path: Path, memo_path: Optional[Path] = None) -> str:
    """Content sha256, memoised by (path, size, mtime) so a large recording hashes once."""
    st = path.stat()
    key = f"{path.resolve()}|{st.st_size}|{st.st_mtime_ns}"
    memo: Dict[str, str] = {}
    if memo_path is not None:
        try:
            memo = json.loads(memo_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            memo = {}
        if isinstance(memo, dict) and isinstance(memo.get(key), str):
            return memo[key]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    if memo_path is not None and isinstance(memo, dict):
        memo[key] = digest
        if len(memo) > 500:
            memo = dict(list(memo.items())[-400:])
        try:
            atomic_write_text(memo_path, json.dumps(memo))
        except OSError:
            pass
    return digest


def params_key(short_edge: int) -> str:
    text = json.dumps([ANALYSIS_VERSION, short_edge, SAMPLE_FPS, CHANGE_YMAX, BBOX_MIN, BLACK_ARGS, SCREEN_FREEZE, CAMERA_FLOORS_DB])
    return f"v{ANALYSIS_VERSION}-{short_edge}-{hashlib.sha256(text.encode()).hexdigest()[:8]}"


def raw_for(tools: Tools, path: Path, *, short_edge: int = SCREEN_SHORT_EDGE, cache_dir: Optional[Path] = None,
            refresh: bool = False) -> Dict[str, Any]:
    """P0-P2 for one file, cached by content sha + parameters under cache_dir."""
    cache_file: Optional[Path] = None
    sha = None
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        sha = file_sha256(path, cache_dir / "shas.json")
        cache_file = cache_dir / f"{sha[:24]}-{params_key(short_edge)}.json"
        if cache_file.is_file() and not refresh:
            try:
                data = json.loads(cache_file.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("version") == ANALYSIS_VERSION:
                    return data
            except (OSError, ValueError):
                pass
    info = probe(tools, path)
    pts = packets(tools, path) if info["vfr"] else []
    scaled = scaled_size(info["width"], info["height"], short_edge)
    logs = decode(tools, path, scaled)
    data = collect(info, pts, logs, scaled)
    data["sha256"] = sha
    if cache_file is not None:
        atomic_write_text(cache_file, json.dumps(data, separators=(",", ":")))
    return data


# ── P3: full-rate small frames and row profiles (kb video log and pair) ──────

PROFILE_VERSION = 1
PROFILE_WIDTH = 54
PROFILE_ROWS = (6, 480)
_SHOWINFO_RE = re.compile(r"\] n:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:\S*\s+duration:\s*(\S+)")
_TIMEBASE_RE = re.compile(r"\] config in time_base: (\d+)/(\d+)")


def profile_size(width: int, height: int) -> Tuple[int, int]:
    """PROFILE_WIDTH wide, an even height keeping the display aspect."""
    if width <= 0 or height <= 0:
        return (PROFILE_WIDTH, PROFILE_WIDTH)
    return (PROFILE_WIDTH, max(2, int(round(height * PROFILE_WIDTH / width / 2.0)) * 2))


def profile_graph(sw: int, sh: int) -> str:
    pw, ph = PROFILE_ROWS
    return (f"[0:v]split=2[a][b];[a]scale={sw}:{sh}:flags=area,format=gray,showinfo[s];"
            f"[b]scale={pw}:{ph}:flags=area,format=gray[p]")


def profile_key() -> str:
    text = json.dumps([PROFILE_VERSION, PROFILE_WIDTH, list(PROFILE_ROWS)])
    return f"p{PROFILE_VERSION}-{hashlib.sha256(text.encode()).hexdigest()[:8]}"


def parse_showinfo(lines: Iterable[str]) -> List[Tuple[Optional[float], Optional[float]]]:
    """showinfo lines -> (pts ms, duration ms) per frame, from the integer pts and the input time base."""
    out: List[Tuple[Optional[float], Optional[float]]] = []
    tb: Optional[Tuple[int, int]] = None
    for line in lines:
        m = _SHOWINFO_RE.search(line)
        if m is None:
            t = _TIMEBASE_RE.search(line)
            if t is not None and int(t.group(2)):
                tb = (int(t.group(1)) * 1000, int(t.group(2)))
            continue
        pts: Optional[float] = None
        dur: Optional[float] = None
        if tb is not None:
            try:
                pts = int(m.group(2)) * tb[0] / tb[1]
            except ValueError:
                pts = None
            try:
                d = int(m.group(3))
                dur = d * tb[0] / tb[1] if 0 < d < (1 << 40) else None
            except ValueError:
                dur = None
        out.append((pts, dur))
    return out


def frame_times(rows: List[Tuple[Optional[float], Optional[float]]], duration_ms: float) -> Tuple[List[float], float]:
    """Rising frame start times (a missing or out-of-order pts follows its predecessor) and the video's end: the later of
    the container duration and the last frame's own end, as the app's constant-rate fill shows it."""
    pts: List[float] = []
    for i, (p, _d) in enumerate(rows):
        if p is None or (pts and p <= pts[-1]):
            step = rows[i - 1][1] if i else None
            p = pts[-1] + (step or 1000.0 / 60) if pts else 0.0
        pts.append(round(max(0.0, p), 3))
    if not pts:
        return [], float(duration_ms)
    return pts, round(max(float(duration_ms), pts[-1] + (rows[-1][1] or 0.0)), 3)


def decode_profile(tools: Tools, path: Path, small: Tuple[int, int], work: Path,
                   timeout_s: float = DECODE_TIMEOUT_S) -> Tuple[List[Tuple[Optional[float], Optional[float]]], bytes, bytes]:
    """One full-rate decode to gray small frames and row profiles (two raw files in work), timed by showinfo."""
    small_raw, rows_raw = work / "small.raw", work / "rows.raw"
    args = [tools.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", str(path), "-filter_complex", profile_graph(*small),
            "-map", "[s]", "-fps_mode", "passthrough", "-f", "rawvideo", "-y", str(small_raw),
            "-map", "[p]", "-fps_mode", "passthrough", "-f", "rawvideo", "-y", str(rows_raw)]
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    except OSError as e:
        raise KbError(f"ffmpeg failed to start: {e}", EXIT_ENV) from None
    timer = threading.Timer(timeout_s, proc.kill)
    timer.start()
    tail: List[str] = []
    try:
        assert proc.stderr is not None
        timing = parse_showinfo(line for line in _keep_tail(proc.stderr, tail) if "showinfo" in line)
        proc.wait()
    finally:
        timer.cancel()
        if proc.stderr is not None:
            proc.stderr.close()
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not decode {path.name}: {' '.join(tail[-3:]).strip()[:400]}")
    return timing, small_raw.read_bytes(), rows_raw.read_bytes()


def _write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _cached_profile(header: Path, small_file: Path, rows_file: Path) -> Optional[Dict[str, Any]]:
    import zlib

    try:
        data = json.loads(header.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != PROFILE_VERSION:
            return None
        sw, sh = data["small"]
        pw, ph = data["rows"]
        n = int(data["frames"])
        small = zlib.decompress(small_file.read_bytes())
        rows = zlib.decompress(rows_file.read_bytes())
    except (OSError, ValueError, KeyError, TypeError, zlib.error):
        return None
    if len(small) != n * sw * sh or len(rows) != n * pw * ph or len(data.get("ptsMs") or []) != n:
        return None
    data["smallData"], data["rowData"] = small, rows
    return data


def profile_pass(tools: Tools, path: Path, *, cache_dir: Optional[Path] = None, refresh: bool = False) -> Dict[str, Any]:
    """Every decoded frame as a PROFILE_WIDTH-wide gray frame plus a 6 x 480 row profile, with its pts; cached by content sha.

    Returns { version, sha256, info, small: [w, h], rows: [w, h], frames, ptsMs, endMs, smallData, rowData }, the two data
    keys being raw bytes frame after frame. Kept apart from raw_for, so analyse's cache, its version and cleanup stay put.
    """
    import tempfile
    import zlib

    files: Optional[Tuple[Path, Path, Path]] = None
    sha = None
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        sha = file_sha256(path, cache_dir / "shas.json")
        stem = f"{sha[:24]}-{profile_key()}"
        files = (cache_dir / f"{stem}.json", cache_dir / f"{stem}.small.z", cache_dir / f"{stem}.rows.z")
        if not refresh:
            hit = _cached_profile(*files)
            if hit is not None:
                return hit
    info = probe(tools, path)
    small = profile_size(info["width"], info["height"])
    work = Path(tempfile.mkdtemp(prefix="kb-profile-", dir=str(cache_dir) if cache_dir is not None else None))
    try:
        timing, small_data, row_data = decode_profile(tools, path, small, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    pw, ph = PROFILE_ROWS
    n = min(len(timing), len(small_data) // (small[0] * small[1]), len(row_data) // (pw * ph))
    if n <= 0:
        raise KbError(f"ffmpeg decoded no frames from {path.name}")
    pts, end = frame_times(timing[:n], float(info.get("durationMs") or 0))
    data: Dict[str, Any] = {"version": PROFILE_VERSION, "sha256": sha, "info": info, "small": list(small), "rows": [pw, ph],
                            "frames": n, "ptsMs": pts, "endMs": end}
    small_data, row_data = small_data[:n * small[0] * small[1]], row_data[:n * pw * ph]
    if files is not None:
        _write_bytes(files[1], zlib.compress(small_data, 6))
        _write_bytes(files[2], zlib.compress(row_data, 6))
        atomic_write_text(files[0], json.dumps(data, separators=(",", ":")))
    data["smallData"], data["rowData"] = small_data, row_data
    return data
