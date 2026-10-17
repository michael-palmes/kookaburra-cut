"""kb command line: argument parsing and one handler per command."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import KB_VERSION
from . import assets as assetmod
from . import bridge
from . import capture as capturemod
from . import catalog as catmod
from . import check as checkmod
from . import docs as docmod
from . import fonts as fontmod
from . import git as gitmod
from . import hooks as hookmod
from . import identity
from . import lock as lockmod
from . import overview
from . import presets as presetmod
from . import scenes as scenemod
from .project import MANIFEST, Project, find_root, stem_of
from .util import (
    DEFAULT_HINTS,
    EXIT_ENV,
    EXIT_OK,
    EXIT_PROBLEMS,
    KbError,
    Report,
    command_name,
    emit,
    emit_err,
    emit_json,
    fmt_secs,
    load_json,
    ok_envelope,
    set_command,
)

SCRIPTS_DIR = Path(__file__).resolve().parent.parent

MAIN_HELP = """\
kb: the one tool for editing a Kookaburra Cut project safely. Run it from the
project folder (it also walks up from the cwd, or uses $CLAUDE_PROJECT_DIR).

  Look       status | context | scenes | check [--app] [--render] [FILE...]
             capture [--scene S] [--at SEC] [--aspect A] [--frames S@SEC,...] [--sheet]
  Scenes     scene add NAME [--preset P | --copy S] [--after S | --at N] [--duration MS] [--name N]
             scene duplicate S | scene move S --to N | scene remove S
             scene set S [--duration MS] [--transition TYPE[:MS]|none] [--ease E] [--name N]
  Documents  doc S get [PATH] | doc S set PATH VALUE | doc S unset PATH | doc S merge JSON
             project get [PATH] | project set PATH VALUE | project unset PATH
             theme list | theme show [ID] | theme set PATH VALUE
  Library    presets [list | show SLUG] | catalog [FAMILY] [--search Q]
             fonts safe | fonts check REF... | fonts list
  Media      assets list | assets add FILE [--name N] | assets probe ASSET
  Video      video list | video show NAME | video new SRC [--for SCENE:SLOT]
             video cut|keep|split|trim|speed|freeze|tap|mask|apply NAME ... (kb video --help)
             video render NAME [--use --scene S] | video use NAME --scene S | video open NAME
  History    checkpoint [MESSAGE] | history | undo [REV] | diff [REV] [--stat]
  Helpers    beats ... | chart ... (soundtrack beats and chart data) | hook EVENT (Claude Code)

S is a scene index (0-based) or file stem (03-pricing). PATH is dotted
(textStyle.titleFont, devices.0.model, devices.+ appends). VALUE is parsed as
JSON when it parses, else kept as a string (--string forces a string).

Every command takes --json (one object on stdout: { "ok", "command", ... }, failures
too) and --agent NAME (who is asking, when several agents share the project).
Writes take --dry-run (list what would change, write nothing) and --wait SECONDS
(wait for another kb write to finish; default 10 s).

Exit codes: 0 ok; 1 problems found or the operation failed (rerunning unchanged
gives the same answer); 2 usage or environment (a person must act, for example
the app is needed but not running); 3 transient (a lock held, the app busy, a
write that kept conflicting): rerun unchanged in a moment.

Examples:
  kb scenes
  kb presets
  kb scene add pricing --preset title --after 02-hero
  kb doc 03-pricing set managedText.items.0.text "Simple pricing"
  kb doc 03-pricing set textStyle.titleFont "JetBrains Mono@400"
  kb check && kb capture --scene 03-pricing --at 1.5
"""


class Ctx:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.json = bool(getattr(args, "json", False))
        self.command = command_name(args)
        self._project: Optional[Project] = None
        self._caller: Optional[identity.Caller] = None

    @property
    def project(self) -> Project:
        if self._project is None:
            self._project = Project(find_root(explicit=getattr(self.args, "project_dir", None)))
            bridge.bind(self._project)
        return self._project

    @property
    def caller(self) -> identity.Caller:
        if self._caller is None:
            self._caller = identity.caller_from(self.args)
        return self._caller

    @property
    def dry_run(self) -> bool:
        return bool(getattr(self.args, "dry_run", False))

    @property
    def wait(self) -> Optional[float]:
        return getattr(self.args, "wait", None)

    @property
    def opts(self) -> lockmod.WriteOpts:
        return lockmod.WriteOpts(self.dry_run, self.wait, self.caller)

    def out(self, payload: Optional[Dict[str, Any]] = None, **kwargs: Any) -> None:
        """The --json envelope for this command (kwargs: ok, code, error; see util.ok_envelope)."""
        emit_json(ok_envelope(self.command, payload, **kwargs))


def emit_writes(writes: List[Dict[str, Any]]) -> None:
    for w in writes:
        emit(f"  {w['action']:<6} {w['path']}")


# ── look ──────────────────────────────────────────────────────────────────────


def cmd_status(ctx: Ctx) -> int:
    if ctx.json:
        ctx.out(overview.status_data(ctx.project))
    else:
        emit(overview.status_text(ctx.project))
    return EXIT_OK


def cmd_context(ctx: Ctx) -> int:
    code, out, _err = hookmod.session_start({}, ctx.project)
    if ctx.json:
        ctx.out({"text": out}, ok=code == EXIT_OK)
    else:
        emit(out)
    return code


def cmd_scenes(ctx: Ctx) -> int:
    project = ctx.project
    rows = overview.roster(project)
    if ctx.json:
        ctx.out({"project": project.project_id, "totalMs": project.total_ms(), "scenes": rows})
        return EXIT_OK
    manifest = project.manifest()
    fmts = manifest.get("formats") if isinstance(manifest.get("formats"), list) else []
    emit(f"Project: {manifest.get('name', '?')} ({project.project_id})")
    emit(f"Theme: {manifest.get('themeId', '?')}   Formats: {' '.join(str(f) for f in fmts)}")
    audio = manifest.get("audio")
    if isinstance(audio, dict):
        emit(f"Audio: {audio.get('file')}")
    emit("")
    width = max([len(str(r.get("stem", ""))) for r in rows] + [10])
    for row in rows:
        line = f"{row['index']:>2}  {str(row.get('stem')):<{width}}  {fmt_secs(row.get('durationMs')):>6}  \"{row.get('name', '')}\""
        label = overview.transition_label(row.get("transition"))
        if label:
            line += f"  {label}"
        if row.get("missing"):
            line += "  !! TSX MISSING"
        emit(line)
        if row.get("sidecarError"):
            emit(f"      !! {row['sidecarError']}")
        for t in row.get("text") or []:
            emit(f"      {t}")
        if row.get("overrides"):
            emit(f"      {'; '.join(row['overrides'])}")
    emit(f"\nTotal: {fmt_secs(project.total_ms())} across {len(rows)} scenes (after transition overlaps)")
    return EXIT_OK


def app_check_issues(resp: Dict[str, Any], report: Report) -> List[str]:
    notes: List[str] = []
    for scene in resp.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        file = str(scene.get("file") or f"scene {scene.get('index')}")
        if not scene.get("ok"):
            report.error(file, f"app {scene.get('phase') or 'load'}", str(scene.get("error") or "failed"))
        for w in scene.get("warnings") or []:
            report.warn(file, "app", str(w))
    for f in resp.get("fonts") or []:
        if isinstance(f, dict) and not f.get("ok"):
            fb = f"; renders as {f.get('fallback')}" if f.get("fallback") else ""
            report.error("fonts", str(f.get("ref")), f"{f.get('error') or 'unreadable'}{fb}. Use a bundled face (kb fonts safe)")
    for a in resp.get("assets") or []:
        if isinstance(a, dict) and not a.get("ok"):
            report.error(str(a.get("path")), "app", str(a.get("error") or "unreadable"))
    for w in resp.get("warnings") or []:
        report.warn("app", "", str(w))
    if resp.get("rendered"):
        notes.append("app: rendered every scene once")
    return notes


def check_film(ctx: Ctx, rest: List[str]) -> int:
    """kb check film ...: the film checks module (kblib/film) parses rest itself; ctx carries --json, -C and --agent."""
    import importlib

    ctx.command = "check film"
    set_command(ctx.command)
    try:
        film = importlib.import_module(f"{__package__}.film.cli")
    except ModuleNotFoundError as e:
        if not (e.name or "").startswith(f"{__package__}.film"):
            raise
        raise KbError("kb check film is not in this kit", EXIT_ENV, kind="env", hint="reopen the project in Kookaburra Cut to update the kit") from None
    return int(film.run(ctx, rest) or 0)


def cmd_check(ctx: Ctx) -> int:
    args = ctx.args
    if args.files and args.files[0] == "film":
        return check_film(ctx, list(args.files[1:]))
    project = ctx.project
    files = None
    if args.files:
        files = []
        for f in args.files:
            p = Path(f)
            if p.is_absolute():
                try:
                    f = p.resolve().relative_to(project.root.resolve()).as_posix()
                except ValueError:
                    raise KbError(f"{f} is outside this project", 2, kind="usage") from None
            files.append(f[2:] if f.startswith("./") else f)
    resp: Optional[Dict[str, Any]] = None
    if args.app or args.render:
        hb = bridge.live_heartbeat()
        resp = bridge.request(
            "check",
            {"project": project.project_id, "render": bool(args.render)},
            args.timeout or (600 if args.render else 300),
            "kb check --app",
        )
        if not resp.get("error"):
            # Recorded before the static pass so fonts the app just vetted stop reading as unvetted.
            fontmod.record_verdicts([f for f in resp.get("fonts") or [] if isinstance(f, dict)], hb.get("appVersion") if hb else None)
    report = checkmod.check_project(project, files=files, heartbeat=bridge.live_heartbeat())
    notes: List[str] = []
    if resp is not None:
        if resp.get("error"):
            report.error("app", "", f"the app could not load the project: {resp['error']}")
        else:
            notes = app_check_issues(resp, report)
            if not resp.get("ok") and not report.errors:
                report.error("app", "", "the app reported a failed check without details; run kb check --app --json")
    if ctx.json:
        out = report.as_json()
        out["app"] = bool(args.app or args.render)
        ctx.out(out, code="invalid", error=f"{report.summary()} ({'static + app' if args.app or args.render else 'static'})")
    else:
        served = bridge.served_line(resp)
        if served:
            emit_err(f"kb: {served}")
        if report.issues:
            emit(report.render())
        for n in notes:
            emit(n)
        scope = "static" + (" + app" if args.app or args.render else "")
        emit(f"{report.summary()} ({scope})" + ("" if report.errors else "; ok"))
    return EXIT_PROBLEMS if report.errors else EXIT_OK


# ── scenes ────────────────────────────────────────────────────────────────────


def after_write(project: Project, files: List[str]) -> Report:
    return checkmod.check_project(project, files=files)


def report_result(ctx: Ctx, verb: str, result: scenemod.Result) -> int:
    project = ctx.project
    stem = stem_of(result.file)
    if result.dry_run:
        if ctx.json:
            ctx.out(result.as_dict())
            return EXIT_OK
        emit(f"dry run, nothing written: {result.file} at index {result.index} (id \"{result.scene_id}\", name \"{result.name}\")")
        for n in result.notes:
            emit(f"  {n}")
        emit_writes(result.writes)
        return EXIT_OK
    files: List[str] = []
    if (project.root / result.file).is_file():
        files += [result.file, f"scenes/{stem}.json"]
    report = after_write(project, files)
    if ctx.json:
        ctx.out(dict(result.as_dict(), check=report.as_json()), ok=not report.errors, code="invalid", error=f"the new scene has problems: {report.summary()}")
    else:
        emit(f"{verb} {result.file} at index {result.index} (id \"{result.scene_id}\", name \"{result.name}\")")
        for n in result.notes:
            emit(f"  {n}")
        if report.issues:
            emit(report.render())
        emit(f"next: kb doc {stem} get, then kb capture --scene {stem}")
    return EXIT_PROBLEMS if report.errors else EXIT_OK


def cmd_scene_add(ctx: Ctx) -> int:
    a = ctx.args
    project = ctx.project
    if a.preset and a.copy:
        raise KbError("pass --preset or --copy, not both", 2, kind="usage")
    place = scenemod.Place(a.after, a.at)
    if a.duration is not None and a.duration <= 0:
        raise KbError("--duration must be a positive number of milliseconds", 2, kind="usage")
    if a.preset:
        preset = presetmod.find(a.preset, project)
        hb = bridge.live_heartbeat()
        kinds = hb.get("kinds") if hb else None
        via_app = hb is not None and not a.offline and not ctx.dry_run and (not isinstance(kinds, list) or "insertPreset" in kinds)
        name = a.name or (overview_name(a.stem) if a.stem else None)
        if via_app:
            position = scenemod.position_from(project, a.after, a.at, len(project.scene_entries()))
            result = presetmod.insert_via_app(project, preset, name, position, a.timeout)
            if a.duration is not None:
                scenemod.set_scene(project, stem_of(result.file), a.duration, None, None, None, ctx.opts)
                result.notes.append(f"durationMs set to {a.duration}")
            return report_result(ctx, "added", result)
        result = presetmod.insert_offline(project, preset, a.stem, name, place, ctx.opts, a.duration)
        if ctx.dry_run:
            result.notes.append("planned as a copy from the app bundle" + ("; with the app running it inserts the preset itself and picks the stem" if hb is not None and not a.offline else ""))
        else:
            result.notes.append("copied from the app bundle (the app was not running)" if hb is None else "copied offline (--offline)")
        if a.duration is not None:
            result.notes.append(f"durationMs set to {a.duration}")
        return report_result(ctx, "added", result)
    if not a.stem:
        raise KbError("scene add needs a NAME (or --preset P); e.g. kb scene add pricing --preset title", 2, kind="usage")
    if a.copy:
        result = scenemod.copy_scene(project, a.copy, a.stem, a.name, place, ctx.opts, a.duration)
        return report_result(ctx, "copied to", result)
    result = scenemod.add_blank(project, a.stem, a.name, a.duration, place, ctx.opts)
    result.notes.append("blank scene: a title on the theme background; presets look better (kb presets)")
    return report_result(ctx, "added", result)


def overview_name(stem: str) -> str:
    from .project import humanise

    return humanise(stem_of(stem))


def cmd_scene_duplicate(ctx: Ctx) -> int:
    a = ctx.args
    place = scenemod.Place(a.after, a.at)
    return report_result(ctx, "duplicated as", scenemod.duplicate(ctx.project, a.scene, place, ctx.opts))


def cmd_scene_move(ctx: Ctx) -> int:
    a = ctx.args
    if (a.to is None) == (a.after is None):
        raise KbError("scene move needs --to N or --after S", 2, kind="usage")
    frm, to, writes = scenemod.move(ctx.project, a.scene, a.to, a.after, ctx.opts)
    if ctx.json:
        ctx.out({"from": frm, "to": to, "writes": writes, "dryRun": ctx.dry_run})
        return EXIT_OK
    if ctx.dry_run:
        emit(f"dry run, nothing written: would move scene {frm} to index {to}; its outgoing transition would move with it")
        emit_writes(writes)
        return EXIT_OK
    emit(f"moved scene {frm} to index {to}; its outgoing transition moved with it")
    return EXIT_OK


def cmd_scene_remove(ctx: Ctx) -> int:
    project = ctx.project
    saved = None
    if not ctx.dry_run and gitmod.git_available() and gitmod.repo_state(project) != "foreign" and gitmod.dirty_files(project):
        saved = gitmod.checkpoint(project, "before kb scene remove")
    idx, trashed, writes = scenemod.remove(project, ctx.args.scene, gitmod.trash, ctx.opts)
    if ctx.json:
        ctx.out({"index": idx, "trashed": trashed, "checkpoint": saved, "writes": writes, "dryRun": ctx.dry_run})
        return EXIT_OK
    if ctx.dry_run:
        emit(f"dry run, nothing written: would remove scene {idx} from project.json" + (f"; would move {', '.join(trashed)} to the Trash" if trashed else ""))
        emit_writes(writes)
        return EXIT_OK
    emit(f"removed scene {idx} from project.json" + (f"; moved {', '.join(trashed)} to the Trash" if trashed else ""))
    if saved:
        emit(f"checkpoint {saved} holds the state before the removal (kb undo {saved})")
    return EXIT_OK


def cmd_scene_set(ctx: Ctx) -> int:
    a = ctx.args
    if a.duration is None and a.transition is None and a.ease is None and a.name is None:
        raise KbError("scene set needs at least one of --duration, --transition, --ease, --name", 2, kind="usage")
    if a.ease is not None and a.ease not in catmod.TRANSITION_EASES:
        raise KbError(f'--ease must be one of {", ".join(catmod.TRANSITION_EASES)}', 2, kind="usage")
    if a.transition and a.transition not in ("none", "cut"):
        kind = a.transition.split(":", 1)[0]
        known = catmod.load_catalog().ids("transitions", catmod.FALLBACK_TRANSITIONS) or []
        if kind not in known:
            raise KbError(f'unknown transition "{kind}".{checkmod.did_you_mean(kind, known)} See kb catalog transitions', 2, kind="usage")
    res = scenemod.set_scene(ctx.project, a.scene, a.duration, a.transition, a.ease, a.name, ctx.opts)
    idx, stem = res["index"], res["stem"]
    if ctx.dry_run:
        if ctx.json:
            ctx.out(res)
            return EXIT_OK
        emit("dry run, nothing written:")
        for c in res["changes"]:
            emit(f"scene {idx} {stem}: {c}")
        emit_writes(res["writes"])
        return EXIT_OK
    report = after_write(ctx.project, ["project.json", f"scenes/{stem}.json"])
    if ctx.json:
        ctx.out(dict(res, check=report.as_json()), ok=not report.errors, code="invalid", error=f"scene {stem} has problems: {report.summary()}")
        return EXIT_PROBLEMS if report.errors else EXIT_OK
    for c in res["changes"]:
        emit(f"scene {idx} {stem}: {c}")
    if report.issues:
        emit(report.render())
    return EXIT_PROBLEMS if report.errors else EXIT_OK


# ── documents ─────────────────────────────────────────────────────────────────


def parse_json_arg(raw: str) -> Any:
    if raw.startswith("@"):
        return load_json(Path(raw[1:]).expanduser(), raw[1:])
    try:
        return json.loads(raw)
    except ValueError as e:
        raise KbError(f"not valid JSON ({e}); quote it for the shell, or pass @file.json", 2, kind="usage") from None


def new_errors(before: Report, after: Report) -> List[Any]:
    old = {(i.path, i.message) for i in before.errors}
    return [i for i in after.errors if (i.path, i.message) not in old]


def guarded_write(
    ctx: Ctx,
    file_label: str,
    target: Any,
    edit: Callable[[Any], Tuple[Any, str]],
    validate: Callable[[Any], Report],
    *,
    lock: bool = True,
) -> int:
    """edit(fresh doc) -> (new doc, summary); refuse new errors unless --force; written by compare-and-swap (kblib.lock),
    so a save in between re-applies the edit to the newer file. lock=False for files outside the project (themes)."""
    force = bool(getattr(ctx.args, "force", False))
    seen: Dict[str, Any] = {}

    def fn(doc: Any) -> Any:
        new, summary = edit(doc)
        before = validate(doc) if doc is not None else Report()
        after = validate(new)
        fresh = new_errors(before, after)
        if fresh and not force:
            lines = "; ".join(f"{i.path}: {i.message}" if i.path else i.message for i in fresh)
            raise KbError(
                f"nothing written; this change would add {len(fresh)} error(s) to {file_label}: {lines}",
                EXIT_PROBLEMS,
                kind="invalid",
                hint="fix the value, or pass --force to write it anyway",
                data={"file": file_label, "issues": [i.as_dict() for i in fresh]},
            )
        seen.update(summary=summary, before=before, after=after, fresh=fresh)
        return new

    mut = lockmod.mutate_json(ctx.project, target, fn, op=f"kb {ctx.command}", caller=ctx.caller, wait=ctx.wait, dry_run=ctx.dry_run, lock=lock, label=file_label)
    before, after, fresh, summary = seen["before"], seen["after"], seen["fresh"], seen["summary"]
    old_keys = {(b.path, b.message) for b in before.issues}
    shown = [i for i in after.issues if (i.path, i.message) not in old_keys]
    code = EXIT_PROBLEMS if after.errors and fresh else EXIT_OK
    if ctx.json:
        payload = {
            "file": file_label, "summary": summary, "written": mut.written, "hash": mut.after_hash, "rebased": mut.rebased,
            "issues": [i.as_dict() for i in shown], "writes": mut.writes, "dryRun": mut.dry_run,
        }
        ctx.out(payload, ok=code == EXIT_OK, code="invalid", error=f"wrote {file_label} with {len(fresh)} new error(s) (--force)")
        return code
    if mut.dry_run:
        emit(f"dry run, nothing written: would write {file_label}: {summary}")
    elif mut.written:
        emit(f"wrote {file_label}: {summary}")
    else:
        emit(f"{file_label} already has that: {summary}")
    for i in shown:
        tag = "error" if i.severity == "error" else "warn "
        emit(f"  {tag}  {i.path}: {i.message}" if i.path else f"  {tag}  {i.message}")
    return code


def sidecar_validator(ctx: Ctx, label: str) -> Any:
    def validate(doc: Any) -> Report:
        checker = checkmod.Checker(checkmod.Context(ctx.project, heartbeat=bridge.read_heartbeat()))
        checker.sidecar_doc(label, doc)
        return checker.report

    return validate


def cmd_doc(ctx: Ctx) -> int:
    a = ctx.args
    project = ctx.project
    try:
        _idx, stem = project.resolve(a.scene)
    except KbError:
        stem = stem_of(a.scene.replace(".json", ".tsx"))
        if not (project.tsx_path(stem).is_file() or project.sidecar_path(stem).is_file()):
            raise
        emit_err(f"kb: note: scenes/{stem}.tsx is not in project.json, so the app does not show it")
    label = f"scenes/{stem}.json"
    if a.op == "get":
        doc = project.load_sidecar(stem)
        if doc is None:
            raise KbError(f"{label} does not exist yet; create it with kb doc {stem} set name \"...\"")
        value: Any = doc
        if a.path:
            found, value = docmod.get_path(doc, a.path)
            if not found:
                raise KbError(f"{a.path} is not set in {label}")
        if ctx.json:
            ctx.out({"file": label, "path": a.path, "value": value})
        else:
            emit_json(value)
        return EXIT_OK
    version = catmod.scene_doc_version(catmod.load_catalog())
    if a.op == "set":
        arg: Any = docmod.parse_value(a.value, a.string)
    elif a.op == "merge":
        arg = parse_json_arg(a.json_patch)
        if not isinstance(arg, dict):
            raise KbError("merge needs a JSON object (RFC 7386 merge patch: null deletes a key)", 2, kind="usage")
    else:
        arg = None

    def edit(doc: Any) -> Tuple[Any, str]:
        if doc is not None and not isinstance(doc, dict):
            raise KbError(f"{label} must be a JSON object")
        if a.op == "unset" and doc is None:
            raise KbError(f"{label} does not exist")
        return docmod.edit(doc if doc is not None else {"version": version}, a.op, getattr(a, "path", "") or "", arg)

    return guarded_write(ctx, label, label, edit, sidecar_validator(ctx, label))


def cmd_project(ctx: Ctx) -> int:
    a = ctx.args
    project = ctx.project
    if a.op == "get":
        manifest = project.manifest()
        if a.path:
            found, value = docmod.get_path(manifest, a.path)
            if not found:
                raise KbError(f"{a.path} is not set in project.json")
        else:
            value = {k: v for k, v in manifest.items() if k != "scenes"} if not a.all else manifest
        if ctx.json:
            ctx.out({"path": a.path, "value": value})
        else:
            emit_json(value)
        return EXIT_OK
    first = docmod.split_path(a.path)[0]
    if first == "scenes":
        raise KbError("the scenes array is managed by kb scene (add, duplicate, move, remove, set); edit sidecars with kb doc", 2, kind="usage")
    arg = docmod.parse_value(a.value, a.string) if a.op == "set" else None

    def edit(manifest: Any) -> Tuple[Any, str]:
        if manifest is None:
            raise KbError("project.json does not exist")
        if not isinstance(manifest, dict):
            raise KbError("project.json must be a JSON object; restore it with kb undo")
        return docmod.edit(manifest, a.op, a.path, arg)

    def validate(m: Any) -> Report:
        checker = checkmod.Checker(checkmod.Context(project, heartbeat=bridge.read_heartbeat()))
        checker.manifest(data=m)
        return checker.report

    code = guarded_write(ctx, "project.json", MANIFEST, edit, validate)
    project.manifest(reload=True)
    return code


def theme_entries() -> List[Dict[str, Any]]:
    return catmod.load_catalog().entries("themes") or []


def cmd_theme(ctx: Ctx) -> int:
    a = ctx.args
    project = ctx.project
    manifest = project.manifest()
    current = manifest.get("themeId") if isinstance(manifest.get("themeId"), str) else ""
    themes_root = project.workspace_root / "themes"
    if a.op == "list":
        bundled = theme_entries()
        workspace = []
        if themes_root.is_dir():
            for folder in sorted(themes_root.iterdir()):
                if (folder / "theme.json").is_file():
                    workspace.append(f"ws:{folder.name}")
        if ctx.json:
            ctx.out({"current": current, "bundled": bundled, "workspace": workspace})
            return EXIT_OK
        emit(f"current: {current}")
        emit(f"bundled ({len(bundled)}):" if bundled else "bundled: (catalog.json has no themes list)")
        for e in bundled:
            emit(f"  {'*' if e.get('id') == current else ' '} {catmod.entry_line(e)}")
        emit(f"workspace ({len(workspace)}), editable with kb theme set --theme ID:")
        for w in workspace:
            emit(f"  {'*' if w == current else ' '} {w}")
        emit("set the project theme: kb project set themeId <id>; one scene: kb doc S set themeId <id>")
        return EXIT_OK
    theme_id = a.theme if getattr(a, "theme", None) else current
    if a.op == "show":
        theme_id = a.id or current
        path = project.theme_file(theme_id)
        if path is not None:
            if not path.is_file():
                raise KbError(f"workspace theme {theme_id} not found at {path}; see kb theme list")
            data = load_json(path, str(path))
            if ctx.json:
                ctx.out({"id": theme_id, "bundled": False, "path": str(path), "theme": data})
            else:
                emit(f"{theme_id} ({path})")
                emit(json.dumps(data, indent=2, ensure_ascii=False))
            return EXIT_OK
        entry = next((e for e in theme_entries() if e.get("id") == theme_id), None)
        if entry is None:
            known = [str(e.get("id")) for e in theme_entries()]
            raise KbError(f'no theme "{theme_id}" in the catalogue.{checkmod.did_you_mean(theme_id, known)} See kb theme list')
        if ctx.json:
            ctx.out({"id": theme_id, "bundled": True, "path": None, "theme": entry})
        else:
            emit(f"{theme_id} (bundled, read-only)")
            emit(json.dumps(entry, indent=2, ensure_ascii=False))
            emit("to customise it, duplicate it into a workspace theme in the app (Theme > Manage), then kb theme set")
        return EXIT_OK
    path = project.theme_file(theme_id)
    if path is None:
        raise KbError(f"{theme_id} is bundled and read-only; duplicate it into a workspace theme in the app first (Theme > Manage), then kb theme set --theme ws:<slug>")
    if not path.is_file():
        raise KbError(f"workspace theme {theme_id} not found at {path}")
    value = docmod.parse_value(a.value, a.string)

    def edit(data: Any) -> Tuple[Any, str]:
        if data is None:
            raise KbError(f"workspace theme {theme_id} not found at {path}")
        return docmod.edit(data, "set", a.path, value)

    def validate(doc: Any) -> Report:
        report = Report()
        typography = doc.get("typography") if isinstance(doc, dict) else None
        if isinstance(typography, dict):
            checker = checkmod.Checker(checkmod.Context(project), report)
            for slot, ref in typography.items():
                if isinstance(ref, dict) and isinstance(ref.get("family"), str):
                    checker.font(theme_id, f"typography.{slot}", f"{ref['family']}@{ref.get('weight', 400)}")
        return report

    emit_err(f"kb: note: {theme_id} is shared by every project that uses it")
    return guarded_write(ctx, f"{theme_id} theme.json", path, edit, validate, lock=False)


# ── library ───────────────────────────────────────────────────────────────────


def cmd_fonts(ctx: Ctx) -> int:
    a = ctx.args
    cat = catmod.load_catalog()
    bundled = fontmod.bundled_fonts(cat)
    if a.op == "safe":
        if ctx.json:
            ctx.out({"faces": [{"family": f, "weights": w} for f, w in bundled.items()]})
            return EXIT_OK
        emit("Bundled faces (always safe, every machine, every export):")
        for family, weights in bundled.items():
            refs = ", ".join(f"{family}@{w}" for w in weights) if weights else family
            emit(f"  {refs}")
        emit('Use in a sidecar: kb doc S set textStyle.titleFont "Inter@600"')
        return EXIT_OK
    hb = None if a.static else bridge.live_heartbeat()
    kinds = hb.get("kinds") if hb else None
    use_app = hb is not None and (not isinstance(kinds, list) or "fonts" in kinds)
    if a.op == "check":
        refs = list(a.refs)
        if use_app:
            resp = bridge.require_ok(bridge.request("fonts", {"refs": refs, "listFamilies": False}, a.timeout, "kb fonts check"), "fonts")
            results = [r for r in resp.get("results") or [] if isinstance(r, dict)]
            fontmod.record_verdicts(results, hb.get("appVersion") if hb else None)
            if ctx.json:
                failed = sum(1 for r in results if not r.get("ok"))
                ctx.out(dict(resp, results=results, static=False), ok=not failed, code="invalid", error=f"{failed} face(s) failed the app's parser")
            bad = 0
            for r in results:
                if r.get("ok"):
                    face = r.get("face") if isinstance(r.get("face"), dict) else {}
                    detail = f" ({face.get('postscript')} {face.get('weight')}, {face.get('file')})" if face else ""
                    if not ctx.json:
                        emit(f"ok    {r.get('ref')}{detail}")
                else:
                    bad += 1
                    if not ctx.json:
                        family, weight = fontmod.parse_ref(str(r.get("ref")))
                        emit(f"BAD   {r.get('ref')}: {r.get('error') or 'unreadable'}; use \"{fontmod.suggest(family, weight, bundled)}\"")
            return EXIT_PROBLEMS if bad else EXIT_OK
        verdicts = [(ref, fontmod.static_verdict(ref, cat)) for ref in refs]
        if ctx.json:
            errors = sum(1 for _, v in verdicts if v.severity == "error")
            rows = [{"ref": r, "severity": v.severity or "ok", "message": v.message} for r, v in verdicts]
            ctx.out({"results": rows, "static": True}, ok=not errors, code="invalid", error=f"{errors} face(s) cannot work")
        else:
            for ref, v in verdicts:
                tag = {"error": "BAD  ", "warning": "?    "}.get(v.severity or "", "ok   ")
                emit(f"{tag} {v.message}")
            emit("(static verdict: the app is not running, so unbundled faces cannot be tested with the real parser)")
        return EXIT_PROBLEMS if any(v.severity == "error" for _, v in verdicts) else EXIT_OK
    if use_app:
        resp = bridge.require_ok(bridge.request("fonts", {"refs": [], "listFamilies": True}, a.timeout, "kb fonts list"), "fonts")
        families = [f for f in resp.get("families") or [] if isinstance(f, dict)]
        if ctx.json:
            ctx.out({"families": families, "static": False})
            return EXIT_OK
        for f in families:
            tag = "bundled" if f.get("bundled") else "system "
            emit(f"{tag}  {f.get('family')}  {', '.join(str(w) for w in f.get('weights') or [])}")
        emit("system faces are unverified until kb fonts check \"Family@weight\" passes")
        return EXIT_OK
    pinned: List[Dict[str, Any]] = []
    fonts_json = ctx.project.workspace_root / "fonts" / "fonts.json"
    try:
        data = json.loads(fonts_json.read_text(encoding="utf-8"))
        pinned = [f for f in data.get("fonts") or [] if isinstance(f, dict)]
    except (OSError, ValueError, AttributeError):
        pinned = []
    if ctx.json:
        ctx.out({"bundled": bundled, "pinned": pinned, "static": True})
        return EXIT_OK
    emit("bundled (safe):")
    for family, weights in bundled.items():
        emit(f"  {family}  {', '.join(map(str, weights))}")
    emit(f"pinned in {fonts_json.parent} (copied from macOS; NOT proof they work):")
    verdicts_cache = fontmod.load_verdicts()
    for f in pinned:
        ref = f"{f.get('family')}@{f.get('weight')}"
        v = fontmod.static_verdict(ref, cat, verdicts_cache)
        tag = {"error": "BAD", "warning": "unverified"}.get(v.severity or "", "ok")
        emit(f"  {ref}  [{tag}]")
    emit("(the app is not running; start it for the full family list from the real parser)")
    return EXIT_OK


def cmd_presets(ctx: Ctx) -> int:
    a = ctx.args
    project = None
    try:
        project = ctx.project
    except KbError:
        project = None
    if a.action == "show":
        if not a.slug:
            raise KbError("presets show needs a SLUG; list them with kb presets", 2, kind="usage")
        p = presetmod.find(a.slug, project)
        if ctx.json:
            ctx.out(p.as_dict())
        else:
            for line in presetmod.describe(p):
                emit(line)
            emit(f"insert: kb scene add <name> --preset {p.ref}  (Read the poster to see it)")
        return EXIT_OK
    found = presetmod.discover(project)
    if ctx.json:
        ctx.out({"presets": [p.as_dict() for p in found]})
        return EXIT_OK
    if not found:
        raise KbError(f"no presets found under {bridge.presets_dir()}; is Kookaburra Cut installed in /Applications?", EXIT_ENV)
    for p in found:
        d = p.as_dict()
        tags = f" [{', '.join(str(t) for t in d['tags'])}]" if d["tags"] else ""
        emit(f"{d['id']:<18} {d['name']}: {d['tagline']}{tags}")
        emit(f"{'':<18} poster {d['poster'] or 'none'}")
    emit("\nRead a poster to see a preset; insert one with kb scene add <name> --preset <slug> [--after S]")
    return EXIT_OK


def cmd_catalog(ctx: Ctx) -> int:
    a = ctx.args
    cat = catmod.load_catalog()
    if not cat.present:
        raise KbError(cat.error or "catalog.json is missing", EXIT_ENV)
    if a.search:
        q = a.search.lower()
        hits: List[str] = []
        for family, _n in cat.families():
            for e in cat.entries(family) or []:
                blob = " ".join(str(e.get(k, "")) for k in ("id", "label", "summary")).lower()
                if q in blob and (not a.family or family == a.family or family.startswith(a.family + ".")):
                    hits.append(f"{family}: {catmod.entry_line(e)}")
        if ctx.json:
            ctx.out({"query": a.search, "items": hits}, ok=bool(hits), error=f'nothing matches "{a.search}"')
        else:
            emit("\n".join(hits) if hits else f'nothing matches "{a.search}"')
        return EXIT_OK if hits else EXIT_PROBLEMS
    if not a.family:
        fams = cat.families()
        if ctx.json:
            ctx.out({"families": {f: n for f, n in fams}})
            return EXIT_OK
        emit(f"catalog.json (app {cat.get('appVersion') or '?'}): kb catalog FAMILY lists one family")
        for f, n in fams:
            emit(f"  {f:<26} {n}")
        return EXIT_OK
    value = cat.get(a.family)
    if value is None:
        names = [f for f, _ in cat.families()] + list(cat.data.keys())
        raise KbError(f'no catalogue family "{a.family}".{checkmod.did_you_mean(a.family, names)} kb catalog lists them', 2, kind="usage")
    if ctx.json:
        ctx.out({"family": a.family, "items": value} if isinstance(value, list) else {"family": a.family, "value": value})
        return EXIT_OK
    entries = catmod.as_entries(value)
    if entries is None:
        emit_json(value)
        return EXIT_OK
    for e in entries:
        emit(catmod.entry_line(e))
    return EXIT_OK


def cmd_assets(ctx: Ctx) -> int:
    a = ctx.args
    project = ctx.project
    if a.op == "list":
        items = assetmod.list_assets(project)
        if ctx.json:
            ctx.out({"assets": items})
            return EXIT_OK
        if not items:
            emit("assets/ is empty; copy media in with kb assets add <file>")
            return EXIT_OK
        for item in items:
            used = ", ".join(item["usedBy"]) if item["usedBy"] else "unused"
            emit(f"{item['path']}  {item['kind']}  {assetmod.human_size(item['bytes'])}  ({used})")
        return EXIT_OK
    if a.op == "add":
        res = assetmod.add(project, a.file, a.name, a.dir, dry_run=ctx.dry_run)
        if ctx.json:
            ctx.out(res)
        elif ctx.dry_run:
            emit(f"dry run, nothing written: would copy {a.file} to {res['path']}" if res["writes"] else f"{res['path']} (identical file already in assets/)")
            if res.get("note"):
                emit_err(f"kb: {res['note']}")
        else:
            emit(res["path"])
            if res.get("note"):
                emit_err(f"kb: {res['note']}")
            if res.get("kind") in ("video", "audio"):
                emit_err(f"kb: kb assets probe {res['path']} gives its duration for durationMs")
        return EXIT_OK
    info = assetmod.probe(project, a.asset)
    if ctx.json:
        ctx.out(info)
    else:
        for key, value in info.items():
            emit(f"{key}: {value}")
    return EXIT_OK


# ── history ───────────────────────────────────────────────────────────────────


def cmd_checkpoint(ctx: Ctx) -> int:
    message = " ".join(ctx.args.message) if ctx.args.message else "manual"
    project = ctx.project
    if ctx.dry_run:
        gitmod.require_git()
        state = gitmod.repo_state(project)
        if state == "foreign":
            raise KbError(f"{project.root} sits inside another git repository; kb only checkpoints a repository rooted at the project folder", EXIT_ENV)
        files = gitmod.dirty_files(project) if state == "own" else [p for p in gitmod.TRACKED if (project.root / p).exists()]
        if ctx.json:
            ctx.out({"rev": None, "saved": False, "files": files, "newRepo": state == "none", "writes": [], "dryRun": True})
        elif files:
            emit(f"dry run, nothing committed: a checkpoint would save {len(files)} path(s)" + (" in a new git repository" if state == "none" else "") + ":")
            for f in files:
                emit(f"  {f}")
        else:
            emit("dry run: nothing changed since the last checkpoint")
        return EXIT_OK
    rev = gitmod.checkpoint(project, message)
    if ctx.json:
        ctx.out({"rev": rev, "saved": rev is not None, "dryRun": False})
    elif rev is None:
        emit("nothing changed since the last checkpoint")
    else:
        emit(f"checkpoint {rev}: project.json, scenes/ and edits/ saved (kb undo {rev} returns here)")
    return EXIT_OK


def cmd_history(ctx: Ctx) -> int:
    rows = gitmod.history(ctx.project, ctx.args.n)
    if ctx.json:
        checkpoints = [dict(r, atMs=int(r["time"]) * 1000 if r["time"].isdigit() else None) for r in rows]
        ctx.out({"checkpoints": checkpoints, "uncommitted": len(gitmod.dirty_files(ctx.project)) if rows else None})
        return EXIT_OK
    if not rows:
        emit("no checkpoints yet (kb checkpoint saves one)")
        return EXIT_OK
    from .util import ago

    for r in rows:
        try:
            when = ago(int(r["time"]) * 1000)
        except ValueError:
            when = "?"
        emit(f"{r['rev']}  {when:<12} {r['subject']}")
    dirty = gitmod.dirty_files(ctx.project)
    if dirty:
        emit(f"(uncommitted: {len(dirty)} file(s); kb diff shows them)")
    return EXIT_OK


def undo_plan(project: Project, rev: Optional[str]) -> Dict[str, Any]:
    """What kb undo would do, touching nothing: the target git.undo picks, then each file it restores or trashes."""
    gitmod.require_git()
    if gitmod.repo_state(project) != "own" or not gitmod.has_head(project):
        raise KbError("no checkpoints yet; make one with kb checkpoint first")
    dirty = gitmod.dirty_files(project)
    if rev:
        target = gitmod.resolve_rev(project, rev)
    elif dirty:
        target = gitmod.resolve_rev(project, "HEAD")
    else:
        prev = gitmod.previous_rev(project)
        if not prev:
            raise KbError("nothing to undo: there is only one checkpoint and no changes since it")
        target = prev
    target_files = set(gitmod.files_at(project, target))
    if "project.json" not in target_files:
        raise KbError(f"checkpoint {target[:7]} has no project.json; pick another from kb history")
    paths = gitmod.tracked_paths(project) or gitmod.TRACKED
    changed = gitmod.run(project.root, ["diff", "--name-only", target, "--"] + paths, check=False).stdout.splitlines()
    untracked = gitmod.run(project.root, ["ls-files", "--others", "--exclude-standard", "--"] + paths, check=False).stdout.splitlines()
    writes: List[Dict[str, Any]] = []
    for rel in sorted({r for r in changed + untracked if r}):
        path = project.root / rel
        if rel in target_files:
            writes.append({"path": rel, "action": "modify" if path.is_file() else "create", "base": lockmod.current_hash(path)})
        elif rel.startswith("scenes/") and path.is_file():
            writes.append({"path": rel, "action": "trash", "base": lockmod.current_hash(path)})
    return {"target": target, "checkpointFirst": bool(dirty), "writes": writes}


def cmd_undo(ctx: Ctx) -> int:
    project = ctx.project
    if ctx.dry_run:
        plan = undo_plan(project, ctx.args.rev)
        if ctx.json:
            ctx.out(dict(plan, dryRun=True))
            return EXIT_OK
        emit(f"dry run, nothing written: would restore project.json, scenes/ and edits/ to {plan['target'][:7]}" + (" (after a checkpoint of the changes since)" if plan["checkpointFirst"] else ""))
        emit_writes(plan["writes"])
        if not plan["writes"]:
            emit("  (no file differs)")
        return EXIT_OK
    edits_before = gitmod.edit_hashes(project)
    with lockmod.project_lock(project, "kb undo", ctx.wait, ctx.caller):
        target, saved, trashed = gitmod.undo(project, ctx.args.rev)
    edits_after = gitmod.edit_hashes(project)
    stale: List[str] = []
    for name in sorted(n for n in edits_after if edits_before.get(n) != edits_after[n]):
        if (project.root / "assets" / f"{name}-edited.mp4").is_file():
            stale.append(f"edits/{name}.json changed; assets/{name}-edited.mp4 is stale (renders are not versioned): kb video render {name}")
        else:
            stale.append(f"edits/{name}.json changed (not rendered yet: kb video render {name})")
    report = checkmod.check_project(project)
    if ctx.json:
        ctx.out({"target": target, "checkpoint": saved, "trashed": trashed, "edits": stale, "check": report.as_json(), "dryRun": False})
        return EXIT_OK
    emit(f"restored project.json, scenes/ and edits/ to {target[:7]}")
    for line in stale:
        emit(line)
    if saved:
        emit(f"the state before this undo is checkpoint {saved} (kb undo {saved} reverts the undo)")
    if trashed:
        emit(f"moved to the Trash (not in {target[:7]}): {', '.join(trashed)}")
    if report.errors:
        emit(report.render("error"))
    emit(f"check: {report.summary()}")
    return EXIT_OK


def cmd_diff(ctx: Ctx) -> int:
    text = gitmod.diff(ctx.project, ctx.args.rev, ctx.args.stat).rstrip("\n")
    if ctx.json:
        ctx.out({"rev": ctx.args.rev, "stat": bool(ctx.args.stat), "diff": text})
    else:
        emit(text)
    return EXIT_OK


# ── helpers ───────────────────────────────────────────────────────────────────


def cmd_hook(ctx: Ctx) -> int:
    payload = hookmod.read_stdin()
    event = ctx.args.event
    try:
        if event == "session-start":
            code, out, err = hookmod.session_start(payload)
        elif event == "pre-edit":
            code, out, err = hookmod.pre_edit(payload)
        else:
            code, out, err = hookmod.post_edit(payload)
    except Exception as e:  # a kb bug must never block the user's edit
        if event == "post-edit":
            note = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": f"kb post-edit check crashed ({type(e).__name__}: {e}); run kb check"}}
            sys.stdout.write(json.dumps(note) + "\n")
        return EXIT_OK
    if out:
        sys.stdout.write(out if out.endswith("\n") else out + "\n")
    if err:
        sys.stderr.write(err if err.endswith("\n") else err + "\n")
    return code


def delegate(name: str, rest: List[str]) -> int:
    """beats and chart run the existing scripts from the project folder, arguments untouched."""
    root = find_root()
    proc = subprocess.run([sys.executable, str(SCRIPTS_DIR / f"{name}.py")] + rest, cwd=str(root))
    return proc.returncode


# ── parser ────────────────────────────────────────────────────────────────────


class Formatter(argparse.RawDescriptionHelpFormatter):
    def __init__(self, prog: str) -> None:
        super().__init__(prog, max_help_position=30, width=100)


class UsageError(Exception):
    def __init__(self, parser: argparse.ArgumentParser, message: str) -> None:
        super().__init__(message)
        self.parser = parser
        self.message = message


class KbParser(argparse.ArgumentParser):
    """In --json mode a usage error becomes the error envelope (kind "usage", exit 2) instead of argparse's exit."""

    json_errors = False

    def error(self, message: str) -> Any:  # type: ignore[override]
        if KbParser.json_errors:
            raise UsageError(self, message)
        return super().error(message)


def build_parser(video_extensions: bool = True) -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="one JSON object on stdout ({ ok, command, ... }), failures too")
    common.add_argument("-C", "--project-dir", default=argparse.SUPPRESS, metavar="DIR", help="the project folder (default: found from the cwd)")
    common.add_argument("--agent", default=argparse.SUPPRESS, metavar="NAME", help="who is asking, when several agents share the project (default session-<id>, or user)")
    structural = argparse.ArgumentParser(add_help=False)
    structural.add_argument("--dry-run", action="store_true", help="list the files this would change; write nothing")
    structural.add_argument("--wait", type=float, nargs="?", const=600.0, default=None, metavar="SECONDS", help="wait for another kb write to finish (default 10 s)")
    writes = [common, structural]

    p = KbParser(prog="kb", description=MAIN_HELP, formatter_class=Formatter, parents=[common])
    p.add_argument("--version", action="version", version=f"kb {KB_VERSION}")
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True

    def add(name: str, help_: str, desc: Optional[str] = None, epilog: Optional[str] = None, write: bool = False) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_, description=desc or help_, epilog=epilog, formatter_class=Formatter, parents=writes if write else [common])

    s = add("status", "app state, this project's last load, kit and checkpoint state")
    s.set_defaults(fn=cmd_status)
    s = add("context", "the session-start briefing: status, scene roster, load errors, key rules (under 4 KB)")
    s.set_defaults(fn=cmd_context)
    s = add("scenes", "scene roster: index, stem, duration, name, transition, text and overrides")
    s.set_defaults(fn=cmd_scenes)

    s = add(
        "check",
        "static checks of project.json, sidecars and scene TSX; --app adds the running app's real load",
        epilog="Static: manifest shape, files, transitions, aspects, theme, audio; sidecar keys, enums, fonts,\n"
        "asset paths (exact case); TSX imports (toolkit only), one defineScene with a unique literal id,\n"
        "no wall clock, timers, Math.random, DOM, <Html> or React hooks.\n"
        "Errors exit 1; warnings print but pass. Fix errors before capturing.\n\n"
        "  kb check                     whole project\n"
        "  kb check scenes/03-x.tsx     one file (plus project.json errors)\n"
        "  kb check --app               + compile, evaluate, fonts and assets in the running app\n"
        "  kb check --render            + render every scene once (slow)",
    )
    s.add_argument("files", nargs="*", metavar="FILE", help="limit to these project files")
    s.add_argument("--app", action="store_true", help="also ask the running app to load the project for real")
    s.add_argument("--render", action="store_true", help="with the app, also render each scene once")
    s.add_argument("--timeout", type=float, default=None, help="seconds to wait for the app (default 300, 600 with --render)")
    s.set_defaults(fn=cmd_check)

    capturemod.register(sub, common, Formatter)

    scene = add("scene", "add, duplicate, move, remove or retime scenes (keeps project.json, files and ids consistent)")
    ss = scene.add_subparsers(dest="op", metavar="OP")
    ss.required = True

    def scene_op(name: str, help_: str, epilog: Optional[str] = None) -> argparse.ArgumentParser:
        return ss.add_parser(name, help=help_, description=help_, epilog=epilog, formatter_class=Formatter, parents=writes)

    x = scene_op(
        "add",
        "new scene: unique numbered stem, fresh defineScene id, registered once",
        epilog="  kb scene add pricing --preset title --after 02-hero   from a preset (best)\n"
        "  kb scene add recap --copy 03-pricing                    copy a scene in this project\n"
        "  kb scene add outro --duration 4000                      blank title scene\n"
        "  kb scene add 07-custom                                  registers scenes/07-custom.tsx if it exists\n"
        "With --preset the app inserts it when running (else kb copies from the app bundle): assets\n"
        "come along, the project's applied background and default transition apply, and NAME becomes\n"
        "the scene name, stem and id (the app picks the number).",
    )
    x.add_argument("stem", nargs="?", metavar="NAME", help="stem or name for the new scene (numbered automatically)")
    x.add_argument("--preset", metavar="P", help="preset slug (kb presets) or ws-preset:<slug>")
    x.add_argument("--copy", metavar="S", help="copy this scene of the project")
    x.add_argument("--after", metavar="S", help="insert after this scene")
    x.add_argument("--at", type=int, metavar="N", help="insert at this index (default: the end)")
    x.add_argument("--duration", type=int, metavar="MS", help="durationMs")
    x.add_argument("--name", metavar="N", help="display name (sidecar name)")
    x.add_argument("--offline", action="store_true", help="copy the preset from the bundle even when the app runs")
    x.add_argument("--timeout", type=float, default=120, help="seconds to wait for the app (default 120)")
    x.set_defaults(fn=cmd_scene_add)
    x = scene_op("duplicate", "copy a scene to a new stem right after it (sidecar ids re-minted, transition kept)")
    x.add_argument("scene", metavar="S")
    x.add_argument("--after", metavar="S2", help="put the copy after this scene instead")
    x.add_argument("--at", type=int, metavar="N", help="put the copy at this index instead")
    x.set_defaults(fn=cmd_scene_duplicate)
    x = scene_op("move", "reorder a scene; its outgoing transition moves with it")
    x.add_argument("scene", metavar="S")
    x.add_argument("--to", type=int, metavar="N", help="new index (0-based)")
    x.add_argument("--after", metavar="S2", help="place it right after this scene")
    x.set_defaults(fn=cmd_scene_move)
    x = scene_op("remove", "drop a scene from project.json and move its files to the macOS Trash")
    x.add_argument("scene", metavar="S")
    x.set_defaults(fn=cmd_scene_remove)
    x = scene_op(
        "set",
        "change a scene's duration, outgoing transition or name",
        epilog="  kb scene set 2 --duration 4500\n  kb scene set 02-hero --transition glasssweep:700 --ease smooth\n  kb scene set 02-hero --transition none      hard cut",
    )
    x.add_argument("scene", metavar="S")
    x.add_argument("--duration", type=int, metavar="MS")
    x.add_argument("--transition", metavar="TYPE[:MS]", help="outgoing transition (kb catalog transitions), or none")
    x.add_argument("--ease", metavar="E", help="transition ease: linear, smooth or snappy")
    x.add_argument("--name", metavar="N", help="display name")
    x.set_defaults(fn=cmd_scene_set)

    d = add(
        "doc",
        "read or edit a scene sidecar (scenes/<stem>.json) by dotted path, validated before writing",
        epilog="  kb doc 03-x get                      whole sidecar\n"
        "  kb doc 03-x get managedText.items\n"
        '  kb doc 03-x set textStyle.titleFont "Inter@600"\n'
        "  kb doc 03-x set textStyle.titleSize 1.25\n"
        "  kb doc 03-x set devices.0.media.src assets/demo.mp4\n"
        "  kb doc 03-x unset textStyle.titleColor\n"
        "  kb doc 03-x merge '{\"background\": {\"type\": \"color\", \"color\": \"#101418\"}}'\n"
        "A write that would add errors is refused (nothing written) unless --force.",
    )
    d.add_argument("scene", metavar="S", help="scene index or stem")
    dsub = d.add_subparsers(dest="op", metavar="OP")
    dsub.required = True
    y = dsub.add_parser("get", help="print the sidecar or one path", parents=[common], formatter_class=Formatter)
    y.add_argument("path", nargs="?")
    y = dsub.add_parser("set", help="set PATH to VALUE (JSON, else string)", parents=writes, formatter_class=Formatter)
    y.add_argument("path")
    y.add_argument("value")
    y.add_argument("--string", action="store_true", help="keep VALUE as a string even if it parses as JSON")
    y.add_argument("--force", action="store_true", help="write even if the result has new errors")
    y = dsub.add_parser("unset", help="remove PATH", parents=writes, formatter_class=Formatter)
    y.add_argument("path")
    y.add_argument("--force", action="store_true")
    y = dsub.add_parser("merge", help="RFC 7386 merge patch (objects merge, null deletes); @file.json reads a file", parents=writes, formatter_class=Formatter)
    y.add_argument("json_patch", metavar="JSON")
    y.add_argument("--force", action="store_true")
    d.set_defaults(fn=cmd_doc)

    pr = add(
        "project",
        "read or edit project.json fields other than scenes (validated before writing)",
        epilog='  kb project get\n  kb project set themeId kookaburra-midnight\n  kb project set formats \'["16:9", "9:16"]\'\n'
        '  kb project set typography.headline "Space Grotesk@600"\n  kb project set defaultTransition \'{"type": "crossfade", "durationMs": 600}\'',
    )
    psub = pr.add_subparsers(dest="op", metavar="OP")
    psub.required = True
    y = psub.add_parser("get", help="print project.json (without scenes) or one path", parents=[common], formatter_class=Formatter)
    y.add_argument("path", nargs="?")
    y.add_argument("--all", action="store_true", help="include the scenes array")
    y = psub.add_parser("set", help="set PATH to VALUE", parents=writes, formatter_class=Formatter)
    y.add_argument("path")
    y.add_argument("value")
    y.add_argument("--string", action="store_true")
    y.add_argument("--force", action="store_true")
    y = psub.add_parser("unset", help="remove PATH", parents=writes, formatter_class=Formatter)
    y.add_argument("path")
    y.add_argument("--force", action="store_true")
    pr.set_defaults(fn=cmd_project)

    t = add("theme", "list themes, show tokens, edit a workspace theme")
    tsub = t.add_subparsers(dest="op", metavar="OP")
    tsub.required = True
    tsub.add_parser("list", help="bundled (catalogue) and workspace themes", parents=[common], formatter_class=Formatter)
    y = tsub.add_parser("show", help="a theme's tokens (default: the project's)", parents=[common], formatter_class=Formatter)
    y.add_argument("id", nargs="?")
    y = tsub.add_parser("set", help="edit a workspace (ws:) theme by dotted path", parents=writes, formatter_class=Formatter,
                        epilog='  kb theme set colors.accent "#ff5a36"\n  kb theme set typography.headline \'{"family": "Inter", "weight": 600}\'')
    y.add_argument("path")
    y.add_argument("value")
    y.add_argument("--theme", metavar="ID", help="ws:<slug> (default: the project's theme)")
    y.add_argument("--string", action="store_true")
    y.add_argument("--force", action="store_true")
    t.set_defaults(fn=cmd_theme)

    f = add(
        "fonts",
        "which faces are safe; check any face with the app's real parser",
        epilog="Bundled faces always work. Any other face is vetted by the app's real parser at load; one that\n"
        "fails falls back to the theme face. Check before you use it:\n"
        '  kb fonts check "Futura@500" "Avenir Next@600"\n'
        "With the app running, check uses its parser and pins each face into ~/Kookaburra Cut/fonts\n"
        "(a side effect: pinned bytes keep exports stable). Without the app the verdict is static.",
    )
    fsub = f.add_subparsers(dest="op", metavar="OP")
    fsub.required = True
    fsub.add_parser("safe", help="bundled faces (always safe)", parents=[common], formatter_class=Formatter)
    y = fsub.add_parser("check", help="verdict per Family@weight (the app's parser when it runs; pins the face into ~/Kookaburra Cut/fonts)", parents=[common], formatter_class=Formatter)
    y.add_argument("refs", nargs="+", metavar="REF")
    y.add_argument("--static", action="store_true", help="skip the app; static verdict only")
    y.add_argument("--timeout", type=float, default=120)
    y = fsub.add_parser("list", help="families available (the app's list when it runs)", parents=[common], formatter_class=Formatter)
    y.add_argument("--static", action="store_true")
    y.add_argument("--timeout", type=float, default=120)
    f.set_defaults(fn=cmd_fonts)

    s = add("presets", "scene presets with taglines, tags and a poster image path to Read")
    s.add_argument("action", nargs="?", choices=["list", "show"], default="list")
    s.add_argument("slug", nargs="?")
    s.set_defaults(fn=cmd_presets)

    s = add(
        "catalog",
        "query catalog.json: every id the app accepts (transitions, themes, devices, ...)",
        epilog="  kb catalog                    families and counts\n  kb catalog transitions\n  kb catalog backgrounds.scene3d\n  kb catalog --search neon",
    )
    s.add_argument("family", nargs="?", metavar="FAMILY")
    s.add_argument("--search", metavar="Q", help="case-insensitive search of ids, labels and summaries")
    s.set_defaults(fn=cmd_catalog)

    s = add("assets", "list media (with which scenes use it), copy media in, probe duration and size")
    asub = s.add_subparsers(dest="op", metavar="OP")
    asub.required = True
    asub.add_parser("list", help="every file under assets/ and who uses it", parents=[common], formatter_class=Formatter)
    y = asub.add_parser("add", help="copy a file into assets/ (never overwrites; prints the path to use)", parents=writes, formatter_class=Formatter)
    y.add_argument("file", metavar="FILE")
    y.add_argument("--name", help="file name inside assets/")
    y.add_argument("--dir", help="subfolder of assets/")
    y = asub.add_parser("probe", help="duration (ms), size, fps and codecs via the app's ffprobe", parents=[common], formatter_class=Formatter)
    y.add_argument("asset", metavar="ASSET")
    s.set_defaults(fn=cmd_assets)

    s = add("checkpoint", "git-commit project.json, scenes/ and edits/ (nothing else)", write=True)
    s.add_argument("message", nargs="*", metavar="MESSAGE")
    s.set_defaults(fn=cmd_checkpoint)
    s = add("history", "recent checkpoints of project.json, scenes/ and edits/")
    s.add_argument("-n", type=int, default=15, help="how many (default 15)")
    s.set_defaults(fn=cmd_history)
    s = add(
        "undo",
        "restore project.json, scenes/ and edits/ from a checkpoint (checkpoints first, so it is undoable)",
        epilog="No REV: back to the last checkpoint (or the one before it when nothing changed since).\n"
        "Scene files that the checkpoint lacks go to the Trash; edit docs never do. Renders\n"
        "(assets/*-edited.mp4) are not versioned: re-render an edit that undo changed.",
        write=True,
    )
    s.add_argument("rev", nargs="?", metavar="REV")
    s.set_defaults(fn=cmd_undo)
    s = add("diff", "changes to project.json, scenes/ and edits/ since the last checkpoint (or REV)")
    s.add_argument("rev", nargs="?", metavar="REV")
    s.add_argument("--stat", action="store_true", help="file summary only")
    s.set_defaults(fn=cmd_diff)

    s = add("hook", "Claude Code hook entry points (stdin JSON); wired by the app in .claude/settings.json")
    s.add_argument("event", choices=["session-start", "pre-edit", "post-edit"])
    s.set_defaults(fn=cmd_hook)

    # A new command module: one import here and mod.register(sub, common, Formatter), as kb video does.
    from .video import commands as videomod

    videomod.register(sub, common, Formatter, extensions=video_extensions)
    from .film import cli as filmcli

    filmcli.register(sub, common, Formatter)

    add("beats", "soundtrack beat grid and key moments per scene (every argument goes to beats.py)")
    add("chart", "chart data and keyframes for a scene (every argument goes to chart.py)")
    return p


def usage_failure(e: UsageError) -> int:
    """argparse's usage error in --json mode: the error envelope on stdout, the usual text on stderr, exit 2."""
    words = [t for t in e.parser.prog.split()[1:] if re.match(r"^[a-z][a-z0-9-]*$", t)]
    command = " ".join(words)
    hint = f"run ./kb {command} --help" if command else DEFAULT_HINTS["usage"]
    emit_json(KbError(e.message, EXIT_ENV, kind="usage", hint=hint).envelope(command))
    sys.stderr.write(e.parser.format_usage())
    emit_err(f"{e.parser.prog}: error: {e.message}")
    return EXIT_ENV


def film_argv(argv: List[str]) -> Optional[Tuple[argparse.Namespace, List[str]]]:
    """kb check film ...: its own options pass through untouched, so it is split off before kb's parser sees them."""
    if "check" not in argv or "film" not in argv:
        return None
    pre = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    pre.add_argument("--json", action="store_true")
    pre.add_argument("-C", "--project-dir")
    pre.add_argument("--agent")
    try:
        ns, rest = pre.parse_known_args(argv)
    except SystemExit:
        return None
    if rest[:2] != ["check", "film"]:
        return None
    ns.command, ns.op = "check", "film"
    return ns, rest[2:]


def run(ctx: Ctx, fn: Callable[[Ctx], Any]) -> int:
    set_command(ctx.command)
    try:
        if ctx.command != "hook":
            identity.bind(ctx.caller)
        return int(fn(ctx) or 0)
    except KbError as e:
        if ctx.json:
            emit_json(e.envelope(ctx.command))
        emit_err(e.text())
        return e.code
    except KeyboardInterrupt:
        if ctx.json:
            emit_json(KbError("interrupted", EXIT_ENV, kind="env", hint="rerun the command").envelope(ctx.command))
        emit_err("kb: interrupted")
        return EXIT_ENV
    except BrokenPipeError:
        return EXIT_OK


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("beats", "chart"):
        try:
            return delegate(argv[0], argv[1:])
        except KbError as e:
            emit_err(f"kb: {e.message}")
            return e.code
    film = film_argv(argv)
    if film is not None:
        ns, rest = film
        return run(Ctx(ns), lambda ctx: check_film(ctx, rest))
    parser = build_parser(video_extensions=argv[:1] == ["video"])
    if argv[:1] == ["hook"]:
        try:
            args = parser.parse_args(argv)
        except SystemExit:
            return EXIT_OK
    else:
        KbParser.json_errors = "--json" in argv
        try:
            args = parser.parse_args(argv)
        except UsageError as e:
            return usage_failure(e)
        finally:
            KbParser.json_errors = False
    return run(Ctx(args), args.fn)
