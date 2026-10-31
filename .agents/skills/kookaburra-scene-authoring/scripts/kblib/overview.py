"""status, context and the scene roster."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import brandlib
from . import bridge
from . import git as gitmod
from .project import BRAND_GUIDE, MANIFEST, Project, find_root, scene_name, stem_of, worktree_of
from .util import KbError, ago, fmt_secs, is_int, read_text

CONTEXT_BUDGET = 4000

RULES = [
    "Run kb as ./kb <command> from this folder, never through a variable or alias. Exit 3: wait retryAfterMs and rerun; 1: fix what it names; 2: tell the user.",
    "Structure goes through kb (./kb scene add/duplicate/move/remove/set, ./kb doc, ./kb project set), new scenes from presets (./kb presets). Change scene files with Edit, Write or ./kb doc, never sed, Python or heredocs.",
    "Scenes import only from @kookaburra/toolkit: no React hooks, Date.now, timers, Math.random, document/window or <Html>; drive motion from useTimeline(). Fonts outside the bundled set need ./kb fonts check first.",
    "After a change: ./kb check --app, then ./kb capture --scene <stem> and Read the PNG; ./kb verify before calling the work done. With no app running, checks are static only: ask the user to open it.",
    "./kb checkpoint before risky work, ./kb undo to roll back. With other agents: --agent <name> on every kb command, ./kb lease <scene> before editing it, --scene on checkpoint and undo, and a ./kb note instead of editing someone else's leased scene.",
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


def app_line(project: Project, hb: Optional[Dict[str, Any]], rows: Optional[List[Dict[str, Any]]] = None) -> str:
    if not hb and rows:
        return "App: running, but no instance serves this project's workspace (see Instances; kb check is static only until one does)"
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


def brand_line(project: Project) -> Optional[str]:
    """The project's brand and where its guidelines are; they are defaults and guidance, never hard rules."""
    try:
        brand = project.brand_id()
    except KbError:
        return None
    if not brand:
        from .brands import all_brands

        try:
            installed = all_brands(project)
        except Exception:
            return None
        if not installed:
            return None
        names = ", ".join(f"{b['name']} ({b['id']})" for b in installed[:6])
        return f"Brand: none. Installed: {names}. When the user asks for one (\"use the {installed[0]['name']} brand\"), apply it with kb brand use <name>, or offer to"
    try:
        name = json.loads(read_text(project.brand_file(brand))).get("name") or brand
    except Exception:
        name = f"{brand} (not in this workspace's brands/)"
    guide = BRAND_GUIDE if (project.root / BRAND_GUIDE).is_file() else f"no {BRAND_GUIDE} yet (re-pick the brand under Project)"
    line = f"Brand {name} ({brand}): read {guide} before designing; its colours, fonts, imagery and voice are safe defaults and guidance, not hard rules"
    folder = brandlib.folder_of(project.workspace_root, brand)
    hint = brandlib.status_hint(folder) if folder else None
    return f"{line}; {hint}" if hint else line


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


def edits_summary(project: Project) -> List[Dict[str, Any]]:
    """Each edit doc: its length, render state and the scenes that play its render (files only, never the CLI)."""
    from .scenes import collect_json_asset_refs
    from .video import editdoc, editmath

    names = editdoc.list_names(project)
    if not names:
        return []
    users: Dict[str, List[str]] = {}
    if project.scenes_dir.is_dir():
        for path in sorted(project.scenes_dir.glob("*.json")):
            try:
                refs = collect_json_asset_refs(json.loads(read_text(path)))
            except (OSError, ValueError, UnicodeDecodeError):
                continue
            for rel in refs:
                users.setdefault(rel, []).append(path.stem)
    out: List[Dict[str, Any]] = []
    for name in names:
        row: Dict[str, Any] = {"name": name, "durationMs": None, "render": {"state": editdoc.render_state(project, name)}, "usedBy": users.get(editdoc.output_rel(name), [])}
        try:
            doc, _sha = editdoc.load(project, name)
            row["durationMs"] = editmath.timeline_duration_ms(editmath.relayout(doc["clips"]))
        except KbError as e:
            row["error"] = e.message
        out.append(row)
    return out


def edits_line(rows: List[Dict[str, Any]], limit: int = 6) -> Optional[str]:
    if not rows:
        return None
    bits = []
    for r in rows[:limit]:
        if r.get("error"):
            bits.append(f"{r['name']} (unreadable: kb video show {r['name']})")
            continue
        state = r["render"]["state"]
        where = f", in {', '.join(r['usedBy'][:3])}" if r["usedBy"] else ""
        hint = f": kb video render {r['name']}" if state == "stale" else ""
        bits.append(f"{r['name']} {fmt_secs(r['durationMs'])} (render {state}{where}{hint})")
    more = f" and {len(rows) - limit} more" if len(rows) > limit else ""
    return f"Edits: {'; '.join(bits)}{more}"


def instance_line(row: Dict[str, Any]) -> str:
    if row["servesThisProject"]:
        why = "serves this project" + (f"; open: {row['openProject']}" if row.get("openProject") else "")
    elif not row["serving"]:
        why = f"bridge off: {row.get('reason') or 'not serving'}"
    else:
        why = "serves another workspace" if row.get("workspaceRoot") else "no workspace configured"
    who = " ".join(str(b) for b in (row.get("build") or "?", row.get("appVersion") or "?", row.get("bundleId") or "") if b)
    star = "*" if row["chosen"] else " "
    return f"  {star} pid {row['pid']} {who}, workspace {row.get('workspaceRoot') or 'none'} ({why})"


def instance_lines(rows: List[Dict[str, Any]]) -> List[str]:
    """Shown when more than one instance is live or none serves this project."""
    serving_here = [r for r in rows if r["servesThisProject"]]
    if not rows or (len(rows) == 1 and serving_here):
        return []
    out = ["Instances:"] + [instance_line(r) for r in rows]
    if len(serving_here) > 1:
        out.append("  several instances serve this workspace; kb addresses the starred one (project open, then release, then the earliest start)")
    return out


def dev_build_lines(hb: Optional[Dict[str, Any]]) -> List[str]:
    if not hb or hb.get("build") != "dev":
        return []
    checkout = hb.get("checkout") if isinstance(hb.get("checkout"), dict) else {}
    where = f" from {checkout['path']}" if checkout.get("path") else ""
    return [
        f"DEV BUILD: a development build serves this project (pid {hb.get('pid')}{where}). React dev builds use far more WebContent memory; "
        "for long or multi-agent sessions ask the user to use the packaged app instead."
    ]


def coordination(project: Project, caller: Any = None, mark: bool = True) -> Tuple[Optional[str], List[str], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(leases line, notes lines, lease rows, unseen notes) for kb status; mark=True records the notes as seen."""
    from . import events, identity, leases

    who = caller if caller is not None else identity.current()
    try:
        rows = leases.rows(project, who)
        unseen = events.unseen_notes(project, who, mark=mark)
        return leases.line(project, who), events.notes_lines(unseen), rows, unseen
    except Exception:  # coordination state is advisory; status must still print
        return None, [], [], []


def brand_images(project: Project, brand: Any) -> Optional[Dict[str, int]]:
    """The project's brand library by folder (kb status --json); None with no brand here."""
    folder = brandlib.folder_of(project.workspace_root, brand)
    return brandlib.counts_by_category(folder) if folder else None


def status_data(project: Project) -> Dict[str, Any]:
    hb = bridge.live_heartbeat(project)
    rows = bridge.instance_rows(project)
    manifest = project.manifest()
    entries = project.scene_entries()
    worktree = session_worktree(project)
    coord = coordination(project)
    return {
        "project": project.project_id,
        "root": str(project.root),
        "worktree": {"path": str(worktree[0]), "main": str(worktree[1]) if worktree[1] else None} if worktree else None,
        "name": manifest.get("name"),
        "themeId": manifest.get("themeId"),
        "brand": manifest.get("brand"),
        "brandImages": brand_images(project, manifest.get("brand")),
        "formats": manifest.get("formats"),
        "scenes": len(entries),
        "totalMs": project.total_ms(),
        "app": {
            "running": hb is not None or bool(rows),
            "servesThisProject": hb is not None,
            "pid": hb.get("pid") if hb else None,
            "bundleId": hb.get("bundleId") if hb else None,
            "build": hb.get("build") if hb else None,
            "workspaceRoot": hb.get("workspaceRoot") if hb else None,
            "version": hb.get("appVersion") if hb else None,
            "openProject": hb.get("openProject") if hb else None,
            "aspect": hb.get("aspect") if hb else None,
            "playheadMs": hb.get("playheadMs") if hb else None,
            "exporting": hb.get("exporting") if hb else None,
        },
        "instances": rows,
        "health": hb.get("health") if hb else None,
        "lastLoad": last_load_for(project, hb),
        "kit": kit_info(project),
        "checkpoint": checkpoint_line(project),
        "edits": edits_summary(project),
        "videoCli": video_cli(),
        "leases": coord[2],
        "notes": coord[3],
        "drift": drift_of(project),
    }


def drift_of(project: Project) -> List[Dict[str, Any]]:
    from . import cuts

    return cuts.drift(project)


def video_cli() -> Dict[str, Any]:
    from .video import appcli

    return appcli.locate_status()


def status_text(project: Project) -> str:
    hb = bridge.live_heartbeat(project)
    rows = bridge.instance_rows(project)
    manifest = project.manifest()
    fmts = manifest.get("formats") if isinstance(manifest.get("formats"), list) else []
    lines = worktree_lines(project) + dev_build_lines(hb) + [
        f"Project: {manifest.get('name', '?')} ({project.project_id}) at {project.root}",
        f"Theme {manifest.get('themeId', '?')} · formats {' '.join(str(f) for f in fmts)} · {len(project.scene_entries())} scenes · {fmt_secs(project.total_ms())}",
        app_line(project, hb, rows),
    ]
    brand = brand_line(project)
    if brand:
        lines.insert(len(lines) - 1, brand)
    lines += instance_lines(rows)
    from .capture import health_lines

    lines += health_lines(hb)
    lines += load_lines(last_load_for(project, hb))
    edits = edits_line(edits_summary(project))
    if edits:
        lines.append(edits)
    lines.append(checkpoint_line(project))
    lines += [f"Timeline: {d['message']}" for d in drift_of(project)]
    lease_line, note_lines, _rows, _unseen = coordination(project)
    if lease_line:
        lines.append(lease_line)
    lines += note_lines
    lines.append(kit_info(project))
    return "\n".join(lines)


def coordination_context(project: Project, caller: Any = None) -> List[str]:
    """The leases line and the newest two notes, for the session-start briefing (nothing is marked seen)."""
    from . import events, leases

    try:
        lease_line = leases.line(project, caller)
        return ([lease_line] if lease_line else []) + events.newest_lines(str(project.root), 2)
    except Exception:
        return []


def context_text(project: Project, check_summary: Optional[List[str]] = None, cwd: Optional[str] = None, caller: Any = None) -> str:
    """The SessionStart text: under 4 KB, most useful first (a worktree STOP banner leads)."""
    hb = bridge.live_heartbeat(project)
    head: List[str] = worktree_lines(project, cwd)
    try:
        manifest = project.manifest()
        fmts = manifest.get("formats") if isinstance(manifest.get("formats"), list) else []
        head.append(f"Kookaburra Cut project \"{manifest.get('name', '?')}\" ({project.project_id}) · theme {manifest.get('themeId', '?')} · {' '.join(str(f) for f in fmts)} · {len(project.scene_entries())} scenes · {fmt_secs(project.total_ms())}")
    except KbError as e:
        head.append(f"Kookaburra Cut project {project.project_id}: project.json problem: {e.message}")
    brand = brand_line(project)
    if brand:
        head.append(brand)
    head.append(app_line(project, hb, None if hb else bridge.instance_rows(project)))
    head += load_lines(last_load_for(project, hb), limit=4)
    if check_summary:
        head += check_summary
    try:
        edits = edits_line(edits_summary(project), limit=3)
        if edits:
            head.append(f"{edits}. Change them only with kb video (the kookaburra-video-editing skill)")
    except Exception:
        pass
    try:
        head.append(checkpoint_line(project))
    except KbError:
        pass
    head += coordination_context(project, caller)
    tail = ["Rules:"] + [f"{i + 1}. {r}" for i, r in enumerate(RULES)]
    tail.append("Tool: ./kb <command> from the project folder (./kb --help lists them; the skill explains the workflow and its reference/gotchas.md the known traps)")
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

