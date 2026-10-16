"""status, context and the scene roster."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import bridge
from . import git as gitmod
from .project import MANIFEST, Project, find_root, scene_name, stem_of, worktree_of
from .util import KbError, ago, fmt_secs, is_int, read_text

CONTEXT_BUDGET = 4000

RULES = [
    "Structural edits go through kb (scene add/duplicate/move/remove/set, doc set, project set); never hand-edit the scenes array in project.json.",
    "Scenes import only from @kookaburra/toolkit: no React hooks (useMemo/useState/useRef...), no Date.now, timers, Math.random, document/window or <Html>. Drive motion from useTimeline().",
    "Fonts: bundled families are always safe (kb fonts safe). Any other face must pass kb fonts check \"Family@weight\" first; a face that fails falls back to the theme face.",
    "After every change: kb check (errors must be zero), then look at it with kb capture --scene <stem> and Read the PNG.",
    "Start new scenes from presets (kb presets, kb scene add <name> --preset <slug>); kb checkpoint before risky work, kb undo to roll back.",
]


def session_worktree(project: Project, cwd: Optional[str] = None) -> Optional[Tuple[Path, Optional[Path]]]:
    """The linked git worktree this session works in (the project's, or the hook cwd's project), else None."""
    starts = [project.root]
    if isinstance(cwd, str) and cwd:
        try:
            starts.append(find_root(Path(cwd)))
        except (KbError, OSError):
            pass
    for start in starts:
        found = worktree_of(start)
        if found:
            return found
    return None


def worktree_lines(project: Project, cwd: Optional[str] = None) -> List[str]:
    """A STOP banner when the session works in a git worktree: the app never sees one, so nothing edited there previews."""
    found = session_worktree(project, cwd)
    return worktree_banner(found) if found else []


def worktree_banner(found: Tuple[Path, Optional[Path]]) -> List[str]:
    tree, main = found
    folder = str(main) if main and (main / MANIFEST).is_file() else "the project folder in ~/Kookaburra Cut"
    return [
        f"STOP: this session runs in a git worktree ({tree}), not the project folder.",
        f"The Kookaburra Cut app only previews, captures and exports {folder}, so edits here never show up and app commands fail. "
        "Edit nothing, and do not copy files across or switch branches to work around it.",
        f"Tell the user, and ask them to start a new session directly in {folder} with worktrees turned off. "
        "Projects need no git workflow: kb checkpoint and kb undo are the whole history.",
    ]


def kit_info(project: Project) -> str:
    kit = project.kit_dir / "kit.json"
    try:
        data = json.loads(read_text(kit))
    except (OSError, ValueError):
        return "kit: unstamped copy"
    return f"kit {data.get('kitVersion', '?')} (app {data.get('appVersion', '?')})"


def last_load_for(project: Project, hb: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    last = hb.get("lastLoad") if isinstance(hb, dict) else None
    if isinstance(last, dict) and last.get("project") == project.project_id:
        return last
    return None


def load_lines(last: Optional[Dict[str, Any]], limit: int = 6) -> List[str]:
    if not last:
        return []
    out: List[str] = []
    when = ago(last.get("atMs"))
    if last.get("ok") and not last.get("sceneErrors") and not last.get("fontIssues") and not last.get("warnings"):
        out.append(f"Last load in the app: ok ({when})")
        return out
    head = "ok with problems" if last.get("ok") else f"FAILED: {last.get('error') or 'unknown error'}"
    out.append(f"Last load in the app ({when}): {head}")
    for e in (last.get("sceneErrors") or [])[:limit]:
        if isinstance(e, dict):
            who = "persistent module" if e.get("index") == -1 else f"scene {e.get('index')}"
            out.append(f"  {who} {e.get('file')} [{e.get('phase')}]: {e.get('message')}")
    for f in (last.get("fontIssues") or [])[:limit]:
        if isinstance(f, dict):
            fb = f" -> rendered as {f.get('fallback')}" if f.get("fallback") else ""
            out.append(f"  font {f.get('ref')}: {f.get('message')}{fb}")
    for w in (last.get("warnings") or [])[:limit]:
        out.append(f"  warning: {w}")
    return out


def app_line(project: Project, hb: Optional[Dict[str, Any]]) -> str:
    if not hb:
        return "App: not running (kb check is static only; capture, check --app and fonts check need the app)"
    open_ = hb.get("openProject")
    here = "this project is open" if open_ == project.project_id else f"open project: {open_ or 'none'}"
    bits = [f"App: running v{hb.get('appVersion', '?')} ({hb.get('build', '?')})", here]
    if open_ == project.project_id:
        bits.append(f"aspect {hb.get('aspect', '?')}")
        if isinstance(hb.get("playheadMs"), (int, float)):
            bits.append(f"playhead {hb['playheadMs'] / 1000:.1f}s")
    if hb.get("exporting"):
        bits.append("EXPORTING (captures wait)")
    return ", ".join(bits)


def checkpoint_line(project: Project) -> str:
    state = gitmod.repo_state(project)
    if state == "none":
        return "Checkpoints: none yet (kb checkpoint starts the history)" if gitmod.git_available() else "Checkpoints: unavailable (git is not installed)"
    if state == "foreign":
        return "Checkpoints: unavailable (the project sits inside another git repository)"
    hist = gitmod.history(project, 1)
    dirty = gitmod.dirty_files(project)
    if not hist:
        return f"Checkpoints: none yet; {len(dirty)} file(s) uncommitted"
    h = hist[0]
    try:
        when = ago(int(h["time"]) * 1000)
    except ValueError:
        when = "?"
    tail = f"{len(dirty)} file(s) changed since" if dirty else "no changes since"
    return f"Last checkpoint: {h['rev']} {when} \"{h['subject']}\"; {tail}"


def roster(project: Project) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    manifest = project.manifest()
    legacy = not (is_int(manifest.get("version")) and manifest["version"] >= 2)
    entries = project.scene_entries()
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            out.append({"index": i, "stem": "?", "error": "not an object"})
            continue
        file = entry.get("file") if isinstance(entry.get("file"), str) else ""
        stem = stem_of(file)
        row: Dict[str, Any] = {"index": i, "stem": stem, "file": file, "durationMs": entry.get("durationMs")}
        spec = entries[i + 1].get("transition") if legacy and i + 1 < len(entries) and isinstance(entries[i + 1], dict) else entry.get("transition")
        if isinstance(spec, dict):
            row["transition"] = spec
        doc: Optional[Dict[str, Any]] = None
        try:
            doc = project.load_sidecar(stem)
        except KbError as e:
            row["sidecarError"] = e.message
        row["name"] = scene_name(doc, stem)
        if not (project.root / file).is_file():
            row["missing"] = True
        if doc:
            row["text"] = scene_text(doc)
            row["overrides"] = overrides(doc)
        out.append(row)
    return out


def scene_text(doc: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    managed_keys = set()
    managed = doc.get("managedText")
    items = managed.get("items") if isinstance(managed, dict) else None
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("key"), str):
                continue
            managed_keys.add(item["key"])
            kind = item.get("type", "?")
            if kind == "bullets":
                value = " / ".join(p.get("text", "") for p in item.get("points") or [] if isinstance(p, dict)) or item.get("text", "")
            elif kind == "icon":
                value = item.get("icon", "")
            else:
                value = item.get("text", "")
            lines.append(f"managedText.{item['key']} ({kind}) = {clip(str(value))}")
    text = doc.get("text")
    if isinstance(text, dict):
        for key, value in text.items():
            if key not in managed_keys and isinstance(value, str):
                lines.append(f"text.{key} = {clip(value)}")
    return lines


def overrides(doc: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    if doc.get("themeId"):
        out.append(f"themeId={doc['themeId']}")
    bg = doc.get("background")
    if isinstance(bg, dict):
        detail = bg.get("look") or bg.get("shader") or bg.get("src") or bg.get("color") or ""
        out.append(f"background={bg.get('type', '?')}" + (f":{detail}" if detail else ""))
    for key in ("backdrop", "lighting", "textAnimation", "textLook", "frame", "layeredScreenshot", "compare", "chart", "terminal", "website"):
        if doc.get(key):
            out.append(key)
    style = doc.get("textStyle")
    if isinstance(style, dict) and style:
        fonts = [f"{k}={v}" for k, v in style.items() if k.endswith("Font")]
        out.append("textStyle(" + ", ".join(fonts or sorted(style)[:4]) + ")")
    camera = doc.get("camera")
    if isinstance(camera, dict) and isinstance(camera.get("keys"), list) and camera["keys"]:
        out.append(f"camera({len(camera['keys'])} keys)")
    devices = doc.get("devices")
    if isinstance(devices, list) and devices:
        models = [f"{d.get('model', '?')}" + (f"[{(d.get('media') or {}).get('src')}]" if isinstance(d.get("media"), dict) and d["media"].get("src") else "") for d in devices if isinstance(d, dict)]
        out.append("devices=" + ", ".join(models))
    media = doc.get("media")
    if isinstance(media, list) and media:
        out.append("media=" + ", ".join(str(m.get("src", "?")) for m in media if isinstance(m, dict)))
    return out


def clip(value: str, width: int = 60) -> str:
    flat = value.replace("\n", "\\n")
    return f'"{flat}"' if len(flat) <= width else f'"{flat[: width - 3]}..."'


def transition_label(spec: Optional[Dict[str, Any]]) -> str:
    if not spec:
        return ""
    ms = spec.get("durationMs")
    return f"-> {spec.get('type', '?')}" + (f" {ms}ms" if ms is not None else "")


def status_data(project: Project) -> Dict[str, Any]:
    hb = bridge.live_heartbeat()
    manifest = project.manifest()
    entries = project.scene_entries()
    worktree = session_worktree(project)
    return {
        "project": project.project_id,
        "root": str(project.root),
        "worktree": {"path": str(worktree[0]), "main": str(worktree[1]) if worktree[1] else None} if worktree else None,
        "name": manifest.get("name"),
        "themeId": manifest.get("themeId"),
        "formats": manifest.get("formats"),
        "scenes": len(entries),
        "totalMs": project.total_ms(),
        "app": {
            "running": hb is not None,
            "version": hb.get("appVersion") if hb else None,
            "openProject": hb.get("openProject") if hb else None,
            "aspect": hb.get("aspect") if hb else None,
            "playheadMs": hb.get("playheadMs") if hb else None,
            "exporting": hb.get("exporting") if hb else None,
        },
        "lastLoad": last_load_for(project, hb),
        "kit": kit_info(project),
        "checkpoint": checkpoint_line(project),
    }


def status_text(project: Project) -> str:
    hb = bridge.live_heartbeat()
    manifest = project.manifest()
    fmts = manifest.get("formats") if isinstance(manifest.get("formats"), list) else []
    lines = worktree_lines(project) + [
        f"Project: {manifest.get('name', '?')} ({project.project_id}) at {project.root}",
        f"Theme {manifest.get('themeId', '?')} · formats {' '.join(str(f) for f in fmts)} · {len(project.scene_entries())} scenes · {fmt_secs(project.total_ms())}",
        app_line(project, hb),
    ]
    lines += load_lines(last_load_for(project, hb))
    lines.append(checkpoint_line(project))
    lines.append(kit_info(project))
    return "\n".join(lines)


def context_text(project: Project, check_summary: Optional[List[str]] = None, cwd: Optional[str] = None) -> str:
    """The SessionStart text: under 4 KB, most useful first (a worktree STOP banner leads)."""
    hb = bridge.live_heartbeat()
    head: List[str] = worktree_lines(project, cwd)
    try:
        manifest = project.manifest()
        fmts = manifest.get("formats") if isinstance(manifest.get("formats"), list) else []
        head.append(f"Kookaburra Cut project \"{manifest.get('name', '?')}\" ({project.project_id}) · theme {manifest.get('themeId', '?')} · {' '.join(str(f) for f in fmts)} · {len(project.scene_entries())} scenes · {fmt_secs(project.total_ms())}")
    except KbError as e:
        head.append(f"Kookaburra Cut project {project.project_id}: project.json problem: {e.message}")
    head.append(app_line(project, hb))
    head += load_lines(last_load_for(project, hb), limit=4)
    if check_summary:
        head += check_summary
    try:
        head.append(checkpoint_line(project))
    except KbError:
        pass
    tail = ["Rules:"] + [f"{i + 1}. {r}" for i, r in enumerate(RULES)]
    tail.append("Tool: python3 .claude/skills/kookaburra-scene-authoring/scripts/kb.py <command> (kb --help lists them; the skill explains the workflow)")
    budget = CONTEXT_BUDGET - len("\n".join(head + tail).encode("utf-8")) - 80
    scene_lines: List[str] = []
    try:
        rows = roster(project)
    except KbError:
        rows = []
    if rows:
        scene_lines.append("Scenes (index stem duration name transition):")
        used = len(scene_lines[0]) + 1
        for n, row in enumerate(rows):
            line = f"  {row['index']} {row['stem']} {fmt_secs(row.get('durationMs'))} \"{row.get('name', '')}\" {transition_label(row.get('transition'))}".rstrip()
            if row.get("missing"):
                line += " MISSING FILE"
            if used + len(line.encode("utf-8")) + 1 > budget:
                scene_lines.append(f"  ... {len(rows) - n} more (kb scenes)")
                break
            scene_lines.append(line)
            used += len(line.encode("utf-8")) + 1
    text = "\n".join(head + scene_lines + tail)
    raw = text.encode("utf-8")
    if len(raw) > CONTEXT_BUDGET:
        text = raw[: CONTEXT_BUDGET - 20].decode("utf-8", "ignore") + "\n... (kb status)"
    return text

