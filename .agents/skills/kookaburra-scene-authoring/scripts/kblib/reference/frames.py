"""One decode of a reference film at small size: where it cuts, where it moves and what colour each stretch is. Pure stdlib over the bundled ffmpeg's raw frames."""

from __future__ import annotations

import subprocess
import tempfile
import threading
from collections import Counter
from operator import sub
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .. import untrusted
from ..util import EXIT_ENV, EXIT_PROBLEMS, KbError

FPS = 30
SMALL = (48, 27)
SAMPLE_EVERY = 15
DECODE_TIMEOUT_S = 1800.0

# Means are of the absolute RGB difference, 0..255, a frame to the one before (every channel: red to blue has no green in it).
HARD_MIN = 6.0
HARD_RATIO = 4.0
HARD_LOCAL_FLOOR = 0.5
HARD_MIN_SHARE = 0.35
PIXEL_CHANGED = 12
LOCAL_WINDOW = 8
FLASH_RETURN = 0.4
MOVE_MIN = 1.5
MOVE_GAP_FRAMES = 3
MOVE_MIN_FRAMES = 6
# A move this short that leaves a different picture behind is a transition; a longer one is a flight, and no boundary.
SOFT_MAX_FRAMES = 60
SOFT_MIN_CHANGE = 18.0
# Change that runs up against a hard cut is a shot that moves, not a way from one shot to the next.
SOFT_CLEAR_FRAMES = 3
STILL_BELOW = 0.3
SELECT_BATCH = 64
# Decoding past what the file declared by this much means the declaration lied, and the length cap never saw the truth.
DECLARED_MARGIN_MS = 10000.0
SEEK_MARGIN_S = 5.0


def frame_ms(frame: int) -> float:
    return frame * 1000.0 / FPS


class Pass:
    """What the decode leaves: per-frame change (`diffs`, `shares`) and every frame small (4 KB each, 210 MB at the 30 minute cap)."""

    def __init__(self) -> None:
        self.diffs: List[float] = []
        self.shares: List[float] = []
        self.pictures: List[bytes] = []

    @property
    def count(self) -> int:
        return len(self.diffs)

    def sampled(self) -> List[int]:
        return list(range(0, self.count, SAMPLE_EVERY))

    def far(self, a: int, b: int) -> float:
        """How different the picture is between two frames."""
        return mean_abs(self.pictures[a], self.pictures[b])

    def returns(self) -> Dict[int, float]:
        """For each big change, how far the frame sits from the one two back: a flash comes back."""
        return {i: self.far(i, i - 2) for i in range(2, self.count) if self.diffs[i] >= HARD_MIN}


def mean_abs(a: bytes, b: bytes) -> float:
    return sum(map(abs, map(sub, a, b))) / len(a) if a else 0.0


def decode(ffmpeg: str, path: Path, declared_ms: float, timeout: float = DECODE_TIMEOUT_S) -> Pass:
    """Every frame of the first video stream on a 30 fps grid, small. A file that runs past the length it declared is refused, so the length cap can't be lied around."""
    most = int((declared_ms + DECLARED_MARGIN_MS) * FPS / 1000.0)
    width, height = SMALL
    size = width * height * 3
    graph = f"fps={FPS}:start_time=0,scale={width}:{height}:flags=area,format=rgb24"
    args = [ffmpeg, "-hide_banner", "-v", "error", "-nostdin", *untrusted.INPUT_ARGS, "-i", str(path),
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", graph, "-f", "rawvideo", "-"]
    out = Pass()
    with tempfile.TemporaryFile() as errors:
        try:
            proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors)
        except OSError as e:
            raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV, kind="env") from None
        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        prev: Optional[bytes] = None
        try:
            assert proc.stdout is not None
            while True:
                frame = proc.stdout.read(size)
                if len(frame) < size:
                    break
                if out.count >= most:
                    proc.kill()
                    raise KbError(f"{path.name} runs past the {declared_ms / 1000:.1f} s it declares, so kb will not read it", EXIT_PROBLEMS, kind="invalid")
                if prev is None:
                    out.diffs.append(0.0)
                    out.shares.append(0.0)
                else:
                    deltas = list(map(abs, map(sub, frame, prev)))
                    d = sum(deltas) / len(deltas)
                    out.diffs.append(d)
                    out.shares.append(sum(1 for v in deltas if v > PIXEL_CHANGED) / len(deltas) if d >= HARD_MIN else 0.0)
                out.pictures.append(frame)
                prev = frame
        finally:
            timer.cancel()
            if proc.stdout is not None:
                proc.stdout.close()
            code = proc.wait()
        if code != 0:
            errors.seek(0)
            tail = errors.read().decode("utf-8", "replace").strip()[-300:]
            raise KbError(f"ffmpeg could not decode {path.name}: {tail or f'exit {code}'}", EXIT_PROBLEMS, kind="invalid")
    if not out.count:
        raise KbError(f"ffmpeg decoded no frames from {path.name}", EXIT_PROBLEMS, kind="invalid")
    return out


def find_hard_cuts(diffs: List[float], shares: List[float], returns: Dict[int, float]) -> List[int]:
    """Frames that open a new shot: a lone spike over most of the picture, its neighbours quiet. A single flash frame spikes twice and comes back, so it is no cut."""
    cuts: List[int] = []
    flash_return: Optional[int] = None
    for i in range(1, len(diffs)):
        d = diffs[i]
        if d < HARD_MIN or shares[i] < HARD_MIN_SHARE or i == flash_return:
            continue
        lo, hi = max(1, i - LOCAL_WINDOW), min(len(diffs), i + LOCAL_WINDOW + 1)
        around = [diffs[j] for j in range(lo, hi) if abs(j - i) > 1]
        local = max(sorted(around)[len(around) // 2] if around else 0.0, HARD_LOCAL_FLOOR)
        if d < HARD_RATIO * local:
            continue
        next_d = diffs[i + 1] if i + 1 < len(diffs) else 0.0
        comeback = returns.get(i + 1)
        if comeback is not None and next_d >= d * 0.5 and comeback < d * FLASH_RETURN:
            flash_return = i + 1
            continue
        if next_d > d:
            continue
        cuts.append(i)
    return cuts


def find_moves(diffs: List[float], cuts: List[int]) -> List[Tuple[int, int]]:
    """Spans of sustained change between hard cuts: [first frame, last frame]."""
    cut_frames = set(cuts)
    spans: List[Tuple[int, int]] = []
    start: Optional[int] = None
    last = 0
    for i, d in enumerate(diffs):
        moving = d >= MOVE_MIN and i not in cut_frames
        if i in cut_frames or (not moving and start is not None and i - last > MOVE_GAP_FRAMES):
            if start is not None and last - start + 1 >= MOVE_MIN_FRAMES:
                spans.append((start, last))
            start = None
        if moving:
            if start is None:
                start = i
            last = i
    if start is not None and last - start + 1 >= MOVE_MIN_FRAMES:
        spans.append((start, last))
    return spans


def boundaries(p: Pass) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(the film's cuts and transitions in time order, its continuous moves). A boundary is { frame, ms, kind: "hard" | "continuous", durationMs }."""
    hard = find_hard_cuts(p.diffs, p.shares, p.returns())
    spans = find_moves(p.diffs, hard)
    found = [{"frame": f, "ms": round(frame_ms(f), 1), "kind": "hard", "durationMs": 0} for f in hard]
    moves: List[Dict[str, Any]] = []
    for a, z in spans:
        length = z - a + 1
        changed = p.far(max(0, a - 1), min(p.count - 1, z + 1))
        mid = (a + z + 1) // 2
        touches_cut = any(a - SOFT_CLEAR_FRAMES <= f <= z + SOFT_CLEAR_FRAMES for f in hard)
        if length <= SOFT_MAX_FRAMES and changed >= SOFT_MIN_CHANGE and not touches_cut:
            found.append({"frame": mid, "ms": round(frame_ms(mid), 1), "kind": "continuous", "durationMs": int(round(frame_ms(length)))})
        else:
            moves.append({"fromMs": round(frame_ms(a), 1), "toMs": round(frame_ms(z + 1), 1),
                          "motion": round(sum(p.diffs[a:z + 1]) / length, 2)})
    found.sort(key=lambda b: b["frame"])
    return found, moves


def dominant_colour(frames: List[bytes]) -> Optional[Dict[str, Any]]:
    """The most common colour across small RGB frames: the fullest 4-bit bucket, as its mean. { hex, share }."""
    buckets: Counter = Counter()
    totals: Dict[Tuple[int, int, int], List[int]] = {}
    pixels = 0
    for frame in frames:
        for i in range(0, len(frame) - 2, 3):
            r, g, b = frame[i], frame[i + 1], frame[i + 2]
            key = (r >> 4, g >> 4, b >> 4)
            buckets[key] += 1
            total = totals.setdefault(key, [0, 0, 0])
            total[0] += r
            total[1] += g
            total[2] += b
            pixels += 1
    if not pixels:
        return None
    key, count = buckets.most_common(1)[0]
    r, g, b = (int(round(v / count)) for v in totals[key])
    return {"hex": f"#{r:02x}{g:02x}{b:02x}", "share": round(count / pixels, 2)}


def segments(p: Pass, found: List[Dict[str, Any]], colour_samples: int = 8) -> List[Dict[str, Any]]:
    """The stretches between boundaries: { index, fromMs, toMs, fromFrame, toFrame, startsWith, endsWith, motion, colour }."""
    edges = [0] + [b["frame"] for b in found] + [p.count]
    kinds = ["start"] + [b["kind"] for b in found] + ["end"]
    out: List[Dict[str, Any]] = []
    for i in range(len(edges) - 1):
        a, z = edges[i], edges[i + 1]
        if z <= a:
            continue
        inner = [p.diffs[f] for f in range(a + 1, z)]
        motion = sum(inner) / len(inner) if inner else 0.0
        inside = list(range(a, z, SAMPLE_EVERY))
        step = max(1, len(inside) // colour_samples)
        chosen = [p.pictures[f] for f in inside[::step][:colour_samples]]
        out.append({
            "index": len(out), "fromFrame": a, "toFrame": z, "fromMs": round(frame_ms(a), 1), "toMs": round(frame_ms(z), 1),
            "startsWith": kinds[i], "endsWith": kinds[i + 1], "motionLevel": round(motion, 2),
            "motion": "still" if motion < STILL_BELOW else ("drift" if motion < MOVE_MIN else "moving"),
            "colour": dominant_colour(chosen),
        })
    return out


def extract(ffmpeg: str, path: Path, frames: List[int], out_dir: Path, stem: str, width: int, quality: int = 3, timeout: float = DECODE_TIMEOUT_S) -> Dict[int, Path]:
    """JPEGs of frames on the 30 fps grid: { frame: path }. ffmpeg's expressions stop parsing at about 100 terms, so frames go in batches, each seeking near its first."""
    order = sorted(set(frames))
    out_dir.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(order), SELECT_BATCH):
        batch = order[start:start + SELECT_BATCH]
        expr = "+".join(f"eq(n\\,{n})" for n in batch)
        graph = f"fps={FPS}:start_time=0,select='{expr}',scale={width}:-2:flags=lanczos"
        seek = frame_ms(batch[0]) / 1000.0 - SEEK_MARGIN_S
        head = ["-noaccurate_seek", "-ss", f"{seek:.3f}", "-copyts", "-start_at_zero"] if seek > 0 else []
        args = [ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-y", *untrusted.INPUT_ARGS, *head, "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
                "-vf", graph, "-fps_mode", "passthrough", "-q:v", str(quality), "-frames:v", str(len(batch)), "-start_number", str(start + 1), str(out_dir / f"{stem}-%05d.jpg")]
        try:
            proc = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
        except OSError as e:
            raise KbError(f"could not run ffmpeg: {e.strerror}", EXIT_ENV, kind="env") from None
        except subprocess.TimeoutExpired:
            raise KbError(f"ffmpeg took longer than {int(timeout)} s on {path.name}", EXIT_PROBLEMS, kind="invalid") from None
        if proc.returncode != 0:
            raise KbError(f"ffmpeg could not read frames from {path.name}: {proc.stderr.strip()[-300:]}", EXIT_PROBLEMS, kind="invalid")
    found: Dict[int, Path] = {}
    for i, frame in enumerate(order, 1):
        p = out_dir / f"{stem}-{i:05d}.jpg"
        if p.is_file():
            found[frame] = p
    return found
