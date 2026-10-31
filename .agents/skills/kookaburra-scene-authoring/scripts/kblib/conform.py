"""The ingest conform from the terminal: the app's headless `media` CLI (`<exe> media probe|conform`) and kb's verdict.

The verdict mirrors conform.rs `evaluate`: VFR, a non-trivial edit list, B-frames beside an edit list or a decoder
disagreement, and non-BT.709 primaries recommend a conform; HDR, 10-bit and unreadable files are refused. kb reads
what needs no app at all: the container's own sample tables (kblib/mp4box.py, the rule mp4box.rs shares through
edit-start-vectors.json) and ffprobe's discarded-packet flags, which catch an edit list that opens inside a frame
(ffmpeg drops that frame and shows the next one at 0 s).
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import mp4box
from .util import EXIT_ENV, EXIT_PROBLEMS, KbError

MEDIA_MIN = 1
CONFORMABLE_EXTS = ("mp4", "mov", "m4v")
PACKET_SCAN = 600
PROBE_TIMEOUT_S = 120.0
DEEP_TIMEOUT_S = 1800.0
CONFORM_TIMEOUT_S = 3600.0
CONFORM_FPS = 60
UPDATE_HINT = "ask the user to install or update Kookaburra Cut"
VERDICT_RANK = {"ok": 0, "suspect": 1, "ffmpeg-misdecodes": 2}
HDR_TRANSFERS = ("SMPTE_ST_2084_PQ", "ITU_R_2100_HLG", "smpte2084", "arib-std-b67")
BT709 = ("ITU_R_709_2", "bt709")
TRANSFORMS = [{"op": "conform", "fps": CONFORM_FPS, "colour": "bt709"}]
# A video named on the command line is untrusted: never a playlist or concat demuxer, which read other files on the disk.
UNTRUSTED_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska"]


# ── tools ─────────────────────────────────────────────────────────────────────


def _usable(path: Optional[str], name: str) -> bool:
    return bool(path) and Path(str(path)).name.startswith(name) and os.path.isfile(str(path)) and os.access(str(path), os.X_OK)


def find_tool(name: str, caps: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """ffmpeg or ffprobe: KB_FFMPEG/KB_FFPROBE, the app CLI's own, the app bundle's, then PATH; None when there is none."""
    env = os.environ.get(f"KB_{name.upper()}")
    if _usable(env, name):
        return env
    entry = caps.get(name) if isinstance(caps, dict) and isinstance(caps.get(name), dict) else {}
    if entry.get("ok") and _usable(entry.get("path"), name):
        return str(entry["path"])
    from . import bridge

    bundled = bridge.resources_dir().parent / "MacOS" / name
    if _usable(str(bundled), name):
        return str(bundled)
    found = shutil.which(name)
    return found if _usable(found, name) else None


def _run(argv: List[str], timeout: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, errors="replace", stdin=subprocess.DEVNULL)
    except OSError as e:
        raise KbError(f"could not run {Path(argv[0]).name}: {e.strerror}", EXIT_ENV, kind="env") from None
    except subprocess.TimeoutExpired:
        raise KbError(f"{Path(argv[0]).name} took longer than {int(timeout)} s", EXIT_ENV, kind="env") from None


# ── ffprobe and ffmpeg ────────────────────────────────────────────────────────


def _tag(stream: Dict[str, Any], key: str) -> Optional[str]:
    value = stream.get(key)
    return value if isinstance(value, str) and value and value not in ("unknown", "unspecified") else None


def _pix_bits(pix_fmt: str) -> int:
    """conform.rs pix_fmt_bits: yuv420p10le is 10; 8 when the name gives no depth."""
    name = pix_fmt[:-2] if pix_fmt.endswith(("le", "be")) else pix_fmt
    head = name.rstrip("0123456789")
    if not (head.endswith("p") or head == "gray"):
        return 8
    try:
        bits = int(name[len(head):])
    except ValueError:
        return 8
    return bits if 9 <= bits <= 16 else 8


def ff_facts(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """conform.rs parse_ff_facts over ffprobe's -show_streams -show_format JSON; None without a video stream."""
    from .video import passes

    streams = [s for s in data.get("streams") or [] if isinstance(s, dict)]
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        return None
    try:
        info = passes.parse_probe(data)
    except KbError:
        return None
    pix_fmt = str(video.get("pix_fmt") or "")
    try:
        raw_bits = int(video.get("bits_per_raw_sample") or 0)
    except (TypeError, ValueError):
        raw_bits = 0
    fmt = data.get("format") or {}
    return {
        "container": str(fmt.get("format_name") or "").split(",")[0],
        "codec": video.get("codec_name"),
        "width": info["width"],
        "height": info["height"],
        "rotation": info["rotation"],
        "rFps": info["rFps"],
        "avgFps": info["avgFps"],
        "vfr": info["vfr"],
        "bframes": int(video.get("has_b_frames") or 0),
        "pixFmt": pix_fmt,
        "bits": max(raw_bits, _pix_bits(pix_fmt)),
        "colour": {k: _tag(video, src) for k, src in (("primaries", "color_primaries"), ("transfer", "color_transfer"), ("matrix", "color_space"), ("range", "color_range"))},
        "hasAudio": any(s.get("codec_type") == "audio" for s in streams),
        "durationMs": info["durationMs"],
        "nbFrames": info["nbFrames"],
        "discardedPackets": None,
    }


def ffprobe_facts(ffprobe: str, path: Path) -> Optional[Dict[str, Any]]:
    """The ffprobe facts plus the leading packets' discard (D) flags; no decode. None when ffprobe can't read it."""
    proc = _run([ffprobe, "-v", "error", *UNTRUSTED_INPUT, "-print_format", "json", "-show_streams", "-show_format", str(path)], PROBE_TIMEOUT_S)
    if proc.returncode != 0:
        return None
    try:
        facts = ff_facts(json.loads(proc.stdout or "{}"))
    except ValueError:
        return None
    if facts is None:
        return None
    flags = _run([ffprobe, "-v", "error", *UNTRUSTED_INPUT, "-select_streams", "v:0", "-read_intervals", f"%+#{PACKET_SCAN}",
                  "-show_entries", "packet=flags", "-of", "csv=p=0", str(path)], PROBE_TIMEOUT_S)
    if flags.returncode == 0:
        facts["discardedPackets"] = sum(1 for line in flags.stdout.splitlines() if line.strip()[1:2] == "D")
    return facts


def showinfo_pts_ms(text: str) -> List[float]:
    out: List[float] = []
    for line in text.splitlines():
        if "showinfo" not in line or "pts_time:" not in line:
            continue
        try:
            out.append(float(line.split("pts_time:", 1)[1].split()[0]) * 1000.0)
        except (IndexError, ValueError):
            continue
    return out


def ffmpeg_decode(ffmpeg: str, path: Path, timeout: float = DEEP_TIMEOUT_S) -> Dict[str, Any]:
    """conform.rs ffmpeg_decode_timing: every frame ffmpeg's own pipeline passes (-fps_mode passthrough), summarised."""
    proc = _run([ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", *UNTRUSTED_INPUT, "-i", str(path),
                 "-map", "0:v:0", "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "null", "-"], timeout)
    if proc.returncode != 0:
        raise KbError(f"ffmpeg could not decode {path.name}: {proc.stderr.strip()[-300:]}", EXIT_PROBLEMS, kind="invalid")
    pts = showinfo_pts_ms(proc.stderr)
    return {"frames": len(pts), "firstPtsMs": mp4box.tenth(pts[0]) if pts else None, "lastPtsMs": mp4box.tenth(pts[-1]) if pts else None}


# ── the app's media CLI ───────────────────────────────────────────────────────


class MediaCli:
    """A located app binary whose `edit caps` lists `media` (an older one would start the GUI on `media`)."""

    def __init__(self, info: Any, caps: Dict[str, Any]) -> None:
        self.info = info
        self.caps = caps
        media = caps.get("media") if isinstance(caps.get("media"), dict) else {}
        self.version = media.get("version")
        self.commands = [c for c in media.get("commands") or [] if isinstance(c, str)]

    def has(self, verb: str) -> bool:
        return isinstance(self.version, int) and not isinstance(self.version, bool) and self.version >= MEDIA_MIN and verb in self.commands


def find_media_cli(verb: str = "probe") -> Tuple[Optional[MediaCli], Optional[str]]:
    """(the CLI, None), or (None, why not) when no app binary is found or it predates `media <verb>`; never raises."""
    from .video import appcli

    try:
        info = appcli.locate()
        caps = appcli.caps(info)
    except KbError as e:
        return None, e.message
    cli = MediaCli(info, caps)
    if not cli.has(verb):
        return None, f"Kookaburra Cut {caps.get('appVersion') or info.app_version or '?'} has no media {verb} (it predates the ingest conform)"
    return cli, None


def require_media_cli(verb: str) -> MediaCli:
    cli, why = find_media_cli(verb)
    if cli is None:
        raise KbError(f"conforming needs the app's media CLI: {why}", EXIT_ENV, kind="env", hint=UPDATE_HINT)
    return cli


def _answer(cli: MediaCli, args: List[str], proc_out: str, proc_err: str, code: int) -> Dict[str, Any]:
    data: Any = None
    lines = [line for line in proc_out.strip().splitlines() if line.strip()]
    for candidate in ([proc_out.strip()] + lines[-1:]):
        try:
            data = json.loads(candidate)
            break
        except ValueError:
            continue
    if not isinstance(data, dict):
        tail = (proc_out or proc_err).strip()[-300:]
        raise KbError(f"Kookaburra Cut's media {args[0]} gave no JSON (exit {code}): {tail or 'no output'}", EXIT_ENV, kind="env")
    if code == 0:
        return data
    from .video.appcli import CliError

    if code == 130:
        raise KbError(f"media {args[0]} was interrupted", EXIT_ENV, kind="env", hint="rerun the command")
    raise CliError(str(data.get("code") or "error"), str(data.get("error") or f"media {args[0]} failed"), data, EXIT_PROBLEMS if code == 1 else EXIT_ENV)


def media_json(cli: MediaCli, args: List[str], timeout: float) -> Dict[str, Any]:
    """One `media <args>` call answering one JSON object."""
    try:
        proc = subprocess.run([cli.info.path, "media"] + args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise KbError(f"Kookaburra Cut's media {args[0]} did not answer within {int(timeout)} s", EXIT_ENV, kind="env") from None
    except OSError as e:
        raise KbError(f"could not run {cli.info.path}: {e.strerror}", EXIT_ENV, kind="env") from None
    return _answer(cli, args, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace"), proc.returncode)


def media_probe(cli: MediaCli, path: Path, pts: bool = False) -> Dict[str, Any]:
    args = ["probe", "--file", str(Path(path).resolve())] + (["--pts"] if pts else [])
    return media_json(cli, args, DEEP_TIMEOUT_S if pts else PROBE_TIMEOUT_S)


def media_conform(
    cli: MediaCli,
    root: Path,
    source_rel: str,
    *,
    name: Optional[str] = None,
    keep: str = "move",
    force: bool = False,
    on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    timeout: float = CONFORM_TIMEOUT_S,
) -> Dict[str, Any]:
    """`media conform`, its JSON lines streamed to on_event; returns the done line. SIGINT and SIGTERM pass to the CLI,
    which stops ffmpeg and takes its staging and kept copy back."""
    args = ["conform", "--project", str(Path(root).resolve()), "--source", source_rel, "--keep-original", keep]
    if name:
        args += ["--name", name]
    if force:
        args.append("--force")
    try:
        proc = subprocess.Popen([cli.info.path, "media"] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise KbError(f"could not run {cli.info.path}: {e.strerror}", EXIT_ENV, kind="env") from None
    lines: "queue.Queue[Optional[bytes]]" = queue.Queue()
    errs: List[bytes] = []

    def pump_out() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    def pump_err() -> None:
        assert proc.stderr is not None
        for chunk in proc.stderr:
            errs.append(chunk)
            del errs[:-40]

    threads = [threading.Thread(target=pump_out, daemon=True), threading.Thread(target=pump_err, daemon=True)]
    for t in threads:
        t.start()
    interrupted: List[int] = []
    previous: Dict[int, Any] = {}

    def forward(signum: int, _frame: Any) -> None:
        interrupted.append(signum)
        try:
            proc.send_signal(signum)
        except OSError:
            pass

    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, forward)
    last: Optional[Dict[str, Any]] = None
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        while True:
            if time.monotonic() > deadline:
                timed_out = True
                _stop(proc)
                break
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(event, dict):
                last = event
                if on_event is not None and event.get("event") in ("start", "progress"):
                    on_event(event)
        try:
            code = proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _stop(proc)
            code = proc.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    for t in threads:
        t.join(timeout=1)
    if interrupted:
        raise KeyboardInterrupt
    if timed_out:
        raise KbError(f"the conform took longer than {int(timeout)} s and was stopped (nothing was replaced)", EXIT_ENV, kind="env")
    if last is not None and last.get("event") == "done" and code == 0:
        return last
    if last is None:
        tail = b"".join(errs).decode("utf-8", "replace").strip()[-300:]
        raise KbError(f"Kookaburra Cut's media conform ended without a result (exit {code}){': ' + tail if tail else ''}", EXIT_ENV, kind="env")
    return _answer(cli, args, json.dumps(last), "", code or 1)


def _stop(proc: "subprocess.Popen[bytes]") -> None:
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except OSError:
        pass


# ── the verdict ───────────────────────────────────────────────────────────────


def _wide_gamut(ff_colour: Dict[str, Any], av_colour: Dict[str, Any]) -> bool:
    tag = av_colour.get("primaries") or ff_colour.get("primaries")
    return bool(tag) and tag not in BT709


def needs_convert(ff_colour: Dict[str, Any], av_colour: Optional[Dict[str, Any]] = None) -> bool:
    """conform.rs needs_colour_convert: wide-gamut primaries or a matrix other than BT.709."""
    av_colour = av_colour or {}
    matrix = av_colour.get("matrix") or ff_colour.get("matrix")
    return _wide_gamut(ff_colour, av_colour) or (bool(matrix) and matrix not in BT709)


def _refusal(ff: Optional[Dict[str, Any]], colour: Dict[str, Any], ext: str) -> Optional[Dict[str, str]]:
    """conform.rs refusal, from what kb can see without AVFoundation."""
    if ext not in CONFORMABLE_EXTS:
        return {"code": "unreadable", "hint": "AVFoundation can't read this video (a WebM or VP9 file?): export it as H.264 or HEVC first"}
    if colour.get("transfer") in HDR_TRANSFERS:
        return {"code": "hdr", "hint": "HDR video (PQ or HLG) can't be conformed: export an SDR version first"}
    if ff is not None and int(ff.get("bits") or 8) > 8:
        return {"code": "10-bit", "hint": "10-bit video can't be conformed: export an 8-bit H.264 or HEVC version first"}
    return None


def colour_of(ff: Optional[Dict[str, Any]], box: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """ffprobe's colour tags, else the container's colr box."""
    tags = dict((ff or {}).get("colour") or {})
    if not any(tags.values()) and box and isinstance(box.get("colour"), dict):
        tags = {k: box["colour"].get(k) for k in ("primaries", "transfer", "matrix", "range")}
    return {k: tags.get(k) for k in ("primaries", "transfer", "matrix", "range")}


def evaluate(ff: Optional[Dict[str, Any]], box: Optional[Dict[str, Any]], ext: str, mismatch: Optional[List[str]] = None) -> Dict[str, Any]:
    """conform.rs evaluate over kb's static facts, plus the container's own edit start; mismatch is a decode comparison's reasons."""
    reasons: List[str] = []
    why: List[str] = []
    verdict = "ok"
    mismatch = list(mismatch or [])
    discarded = (ff or {}).get("discardedPackets")
    edited = bool(box and box.get("edited")) or (isinstance(discarded, int) and discarded > 0)
    if (ff or {}).get("vfr") or (box or {}).get("vfr"):
        reasons.append("vfr")
        why.append("vfr")
    if edited:
        reasons.append("edit-list")
        why.append("edit-list")
        verdict = "suspect"
    if box and box.get("editStart") == "mid-sample":
        reasons.append("edit-mid-sample")
        verdict = "ffmpeg-misdecodes"
    if int((ff or {}).get("bframes") or 0) > 0 or (box or {}).get("reorders"):
        reasons.append("b-frames")
        if edited or mismatch:
            why.append("b-frames")
    colour = colour_of(ff, box)
    if _wide_gamut(colour, {}):
        reasons.append("primaries")
        why.append("primaries")
    if mismatch:
        verdict = "ffmpeg-misdecodes"
        why.append("decoders")
        reasons.extend(r for r in mismatch if r not in reasons)
    refused = _refusal(ff, colour, ext)
    if refused is not None:
        reasons.append(refused["code"])
    return {"verdict": verdict, "reasons": reasons, "recommended": bool(why) and refused is None, "why": why, "refused": refused}


def merge(app: Dict[str, Any], static: Dict[str, Any]) -> Dict[str, Any]:
    """The app's verdict with what the container parse adds (an edit inside a frame, for app builds before mp4box.rs); the app's refusal stands."""
    conform = app.get("conform") if isinstance(app.get("conform"), dict) else {}
    verdict = str(app.get("verdict") or "ok")
    if VERDICT_RANK.get(static["verdict"], 0) > VERDICT_RANK.get(verdict, 0):
        verdict = static["verdict"]
    reasons = [str(r) for r in app.get("reasons") or []]
    reasons += [r for r in static["reasons"] if r not in reasons and r not in ("unreadable", "hdr", "10-bit")]
    why = [str(w) for w in conform.get("why") or []]
    refused = conform.get("refused") if isinstance(conform.get("refused"), dict) else None
    if static["recommended"]:
        why += [w for w in static["why"] if w not in why]
    return {"verdict": verdict, "reasons": reasons, "recommended": bool(why) and refused is None, "why": why, "refused": refused}


def ext_of(path: Path) -> str:
    return path.name.rsplit(".", 1)[-1].lower() if "." in path.name else ""


def static_facts(path: Path, cli: Optional[MediaCli] = None) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """(container facts, ffprobe facts), each None when unavailable; no decode."""
    box = mp4box.probe(path) if ext_of(path) in CONFORMABLE_EXTS else None
    ffprobe = find_tool("ffprobe", cli.caps if cli else None)
    return box, (ffprobe_facts(ffprobe, path) if ffprobe else None)


def summary(result: Dict[str, Any]) -> Dict[str, Any]:
    return {k: result[k] for k in ("verdict", "reasons", "recommended", "why", "refused")}


def video_verdict(path: Path, *, deep: bool = False, use_app: bool = True, command: Optional[str] = None) -> Dict[str, Any]:
    """The `decode` block of `kb assets probe` for one video file (see module docstring)."""
    ext = ext_of(path)
    checks: List[str] = []
    cli: Optional[MediaCli] = None
    app_note: Optional[str] = None
    if use_app:
        cli, app_note = find_media_cli("probe")
    box, ff = static_facts(path, cli)
    if box is not None:
        checks.append("container")
    if ff is not None:
        checks.append("ffprobe")
    app: Optional[Dict[str, Any]] = None
    if cli is not None and ext in CONFORMABLE_EXTS:
        try:
            app = media_probe(cli, path, pts=deep)
            checks.append("app")
        except KbError as e:
            app_note = f"the app's media probe failed: {e.message}"
    mismatch: Optional[List[str]] = None
    ff_decode: Optional[Dict[str, Any]] = None
    if deep and app is None and box is not None and box.get("expected"):
        ffmpeg = find_tool("ffmpeg", cli.caps if cli else None)
        if ffmpeg:
            ff_decode = ffmpeg_decode(ffmpeg, path)
            mismatch = mp4box.span_reasons(box["expected"], ff_decode)
            checks.append("decode")
    static = evaluate(ff, box, ext, mismatch)
    result = merge(app, static) if app is not None else static
    if app is not None and deep:
        checks.append("decode")
    colour = colour_of(ff, box)
    av = app.get("avfoundation") if app is not None and isinstance(app.get("avfoundation"), dict) else None
    ffmpeg_block: Dict[str, Any] = dict(ff or {})
    ffmpeg_block.pop("colour", None)
    app_ff = app.get("ffmpeg") if app is not None and isinstance(app.get("ffmpeg"), dict) else {}
    if isinstance(app_ff.get("decode"), dict):
        ffmpeg_block["decode"] = app_ff["decode"]
    elif ff_decode is not None:
        ffmpeg_block["decode"] = ff_decode
    block: Dict[str, Any] = {
        "verdict": result["verdict"],
        "reasons": result["reasons"],
        "ffmpeg": ffmpeg_block or None,
        "avfoundation": av,
        "container": None if box is None else {k: box.get(k) for k in ("codec", "timescale", "samples", "durationMs", "keyframes", "reorders", "vfr", "fragmented", "editStart", "expected")},
        "editList": (box or {}).get("editList") or [],
        "colour": dict(colour, needsConvert=needs_convert(colour, (av or {}).get("colour") if av else None)),
        "conform": {
            "recommended": result["recommended"],
            "why": result["why"],
            "refused": result["refused"],
            "command": command if result["recommended"] else None,
        },
        "checks": checks,
    }
    if app is not None and app.get("avfoundationError"):
        block["avfoundationError"] = app["avfoundationError"]
    if app_note and app is None:
        block["appNote"] = app_note
    return block


def container_verdict(path: Path) -> Optional[Dict[str, Any]]:
    """The container-only verdict (no subprocess, for kb check); None when the file isn't a movie mp4box reads."""
    ext = ext_of(path)
    if ext not in CONFORMABLE_EXTS:
        return None
    box = mp4box.probe(path)
    return None if box is None else evaluate(None, box, ext)


def import_decision(path: Path, *, deep: bool = True, say: Optional[Callable[[str], None]] = None) -> Dict[str, Any]:
    """Whether an import conforms: the app's static probe merged with the container check when the app's media CLI is
    there, else kb's own check, which can only warn. A file the static probe passes only looks clean until both decoders
    have read it, so it is decoded before the conform is skipped. { conform, checked, why, probe, refused, cli }."""
    cli, why_not = find_media_cli("conform")
    if cli is not None and not cli.has("probe"):
        cli, why_not = None, "the app's media CLI has no probe"
    box, ff = static_facts(path, cli)
    static = evaluate(ff, box, ext_of(path))
    if cli is None:
        if deep and not static["recommended"] and box is not None and box.get("expected"):
            static = evaluate(ff, box, ext_of(path), _container_mismatch(path, box, say))
        return {"conform": False, "checked": False, "why": why_not or "no app", "probe": summary(static), "refused": None, "cli": None}
    try:
        report = media_probe(cli, path)
    except KbError as e:
        return {"conform": False, "checked": False, "why": f"the app's probe failed: {e.message}", "probe": summary(static), "refused": None, "cli": None}
    merged = merge(report, static)
    checks: Optional[List[str]] = None
    if deep and not merged["recommended"] and merged["refused"] is None:
        if say is not None:
            say(f"decoding {path.name} to check it plays the same in both decoders")
        try:
            merged = merge(media_probe(cli, path, pts=True), static)
        except KbError as e:
            return {"conform": False, "checked": False, "why": f"the app's deep probe failed: {e.message}", "probe": summary(merged), "refused": None, "cli": None}
        checks = ["app", "decode"]
    return {"conform": merged["recommended"], "checked": True, "why": None, "probe": summary(merged), "refused": merged["refused"], "cli": cli, "checks": checks}


def _container_mismatch(path: Path, box: Dict[str, Any], say: Optional[Callable[[str], None]]) -> Optional[List[str]]:
    """Without the app: ffmpeg's decode against the timeline the container promises; None when it can't be read."""
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        return None
    if say is not None:
        say(f"decoding {path.name} to check it plays as its container says")
    try:
        return mp4box.span_reasons(box["expected"], ffmpeg_decode(ffmpeg, path))
    except KbError:
        return None
