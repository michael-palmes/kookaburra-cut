import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BridgeExportRequest,
  type BridgeFailure,
  type BridgeProgress,
  BridgeProgressTracker,
  bridgeExportFacts,
  bridgeExportRefusal,
  bridgeFailureFor,
  type EditorActivity,
  isBridgeFailure,
  isHardwareLane,
  parseBridgeExportRequest,
  resolveBridgeChoice,
  syncSources,
  type VideoRun,
  type VideoRunResult,
} from "../engine/bridgeExport";
import type { AspectName, FormatSpec } from "../engine/format";
import { type LoadedProject, nativeProjectSlug } from "../engine/project";
import { settleSceneDocWrites } from "../engine/sceneDoc";
import { sceneErrorRefusal } from "../engine/sceneErrors";
import { projectFileStamps, sourceBaselineStamps } from "../engine/sourceBaseline";
import { getSettings, listExportPresets } from "../engine/workspace";
import { findBundledPreset } from "../export/presetRegistry";
import { type ExportPresetDoc, parseExportPreset } from "../export/presetSchema";
import {
  type LoudnessMeasure,
  measureLoudnessArgs,
  resolveVideoSelection,
  type VideoExportSelection,
} from "../export/selection";
import { useEditorStore } from "../store/editorStore";
import {
  openingPosterFrameEnabled,
  terminalSnapshotWarning,
  websiteCaptureWarning,
} from "./exportOptions";

/** What App lends the bridge export: its state, its reload signals and the Export button's own run. */
export interface BridgeExportHost {
  isAutoRun: boolean;
  view: string;
  project: LoadedProject | null;
  exporting: boolean;
  showExport: boolean;
  themePreviewRunning: { readonly current: boolean };
  /** The persistent live-reload failure, if the last reload failed. */
  reloadError: string | null;
  /** A reload the source poll asked for has not landed yet. */
  loadInFlight: () => boolean;
  stopPlayback: () => void;
  runVideoExport: (sel: VideoExportSelection, run: VideoRun) => Promise<VideoRunResult>;
  commitFormat: (format: FormatSpec) => Promise<void>;
}

export interface BridgeOverlayState {
  id: string;
  verify: boolean;
  client: string | null;
  progress: BridgeProgress;
  cancelling: boolean;
}

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "time",
]);

interface FocusLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** A text field, select or editable region, where a focus can mean the person is mid-edit; the embedded Claude terminal's input never counts (Claude itself types there). */
export function isEditingFocus(el: FocusLike | null | undefined): boolean {
  if (!el?.tagName) return false;
  if (el.closest?.(".terminal-panel, .xterm")) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((el.type ?? "").toLowerCase());
  return el.isContentEditable === true;
}

/** A focused field holds off `kb export` only this long after the person last typed in or changed one. */
export const FIELD_EDIT_IDLE_MS = 10_000;

/** When the person last typed in or changed a field (key, input and change events on one), so a field left focused while they look away does not block Claude's export. */
export class FieldActivity {
  private lastEditAt: number | null = null;

  note(target: FocusLike | null | undefined, now: number): void {
    if (isEditingFocus(target)) this.lastEditAt = now;
  }

  /** A focused field, typed in or changed in the last 10 s. */
  editing(focused: FocusLike | null | undefined, now: number): boolean {
    return (
      this.lastEditAt !== null &&
      now - this.lastEditAt < FIELD_EDIT_IDLE_MS &&
      isEditingFocus(focused)
    );
  }
}

/** Bundled presets plus the workspace's `ws:` ones, as the modal lists them. */
async function presetFinder(): Promise<(id: string) => ExportPresetDoc | undefined> {
  const user = new Map<string, ExportPresetDoc>();
  try {
    for (const listing of await listExportPresets()) {
      const id = `ws:${listing.slug}`;
      try {
        const doc = parseExportPreset(JSON.parse(listing.json), id);
        if (doc) user.set(id, { ...doc, id });
      } catch {
        // an unreadable user preset is skipped, as in the modal
      }
    }
  } catch {
    // no workspace presets
  }
  return (id) => (id.startsWith("ws:") ? user.get(id) : findBundledPreset(id));
}

async function appPosterFrame(): Promise<boolean> {
  try {
    return openingPosterFrameEnabled((await getSettings()).disableOpeningPosterFrame);
  } catch {
    return openingPosterFrameEnabled(undefined);
  }
}

const REPORT_MS = 250;

/** One accepted request, start to finish: the sync, the modal's selection, then the Export button's own run. Refusals come back as values; a failed run throws. */
async function runRequest(
  req: BridgeExportRequest,
  hostRef: { readonly current: BridgeExportHost },
  activity: EditorActivity,
  abort: AbortController,
  editorAspect: AspectName,
  tracker: BridgeProgressTracker,
  report: () => void,
): Promise<Record<string, unknown> | BridgeFailure> {
  hostRef.current.stopPlayback();
  const slug = nativeProjectSlug(req.project);
  const stale = await syncSources(req.sources, {
    settleWrites: settleSceneDocWrites,
    stamps: () => projectFileStamps(slug),
    baseline: () => sourceBaselineStamps(slug),
    loadInFlight: () => hostRef.current.loadInFlight(),
    reloadError: () => hostRef.current.reloadError,
    hashes: (files) => invoke<string[]>("project_file_hashes", { slug, files }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    aborted: () => abort.signal.aborted,
  });
  if (stale) return stale;
  // Read after the sync: a reload it waited for swapped the project in.
  const h = hostRef.current;
  const project = h.project;
  const lost = bridgeExportRefusal(req, {
    ...activity,
    view: h.view,
    openProjectId: project?.id ?? null,
  });
  if (lost || !project) return lost ?? bridgeFailureFor("the project closed", false, "user");
  const blocked = sceneErrorRefusal(project, req.verify ? "verify" : "export");
  if (blocked) return { ok: false, code: "refused", error: blocked };
  const picked = resolveBridgeChoice(req, editorAspect, await presetFinder());
  if (isBridgeFailure(picked)) return picked;
  const posterFrame = req.posterFrame ?? (await appPosterFrame());
  const measure = (fps: number, poster: boolean) =>
    project.audio
      ? invoke<LoudnessMeasure>(
          "measure_loudness",
          measureLoudnessArgs(project.audio, project.totalMs, fps, poster),
        )
      : Promise.resolve(null);
  const resolved = await resolveVideoSelection(picked.choice, picked.aspect, posterFrame, measure);
  if (resolved.error !== undefined) return { ok: false, code: "invalid", error: resolved.error };
  if (req.verify && isHardwareLane(resolved.sel)) {
    return {
      ok: false,
      code: "invalid",
      error: `--verify needs a software encoder, and ${resolved.sel.presetId} encodes with VideoToolbox (not bit-exact)`,
      hint: "drop --verify, or pick a libx264, libx265 or ProRes preset",
    };
  }
  const run = await h.runVideoExport(resolved.sel, {
    abort,
    destination: "project",
    verify: req.verify === true,
    onProgress: (p) => {
      tracker.onProgress(p);
      report();
    },
    onPrepareStep: (step) => {
      tracker.onPrepareStep(step);
      report();
    },
  });
  const warnings = [
    terminalSnapshotWarning(project.sceneDocs, project.sceneFiles),
    websiteCaptureWarning(project.sceneDocs, project.sceneFiles),
  ].filter((w): w is string => !!w);
  return bridgeExportFacts(project, resolved.sel, run.options, run.verify ?? null, warnings);
}

/** Serves Claude's `kb export` in the main window: refuses unless the project is open and the person idle, lands pending reloads, then runs the Export button's own export into the project's exports/ folder and hands Rust the facts. */
export function useBridgeExport(host: BridgeExportHost): {
  overlay: BridgeOverlayState | null;
  cancel: () => void;
} {
  const hostRef = useRef(host);
  hostRef.current = host;
  const pointerDown = useRef(false);
  const fields = useRef(new FieldActivity());
  const running = useRef<{ id: string; abort: AbortController; by: string } | null>(null);
  const [overlay, setOverlay] = useState<BridgeOverlayState | null>(null);
  const autoRun = host.isAutoRun;

  useEffect(() => {
    if (autoRun) return;
    const down = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
    };
    const edited = (e: Event) => fields.current.note(e.target as FocusLike | null, Date.now());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    for (const type of ["keydown", "input", "change"]) window.addEventListener(type, edited, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
      for (const type of ["keydown", "input", "change"])
        window.removeEventListener(type, edited, true);
    };
  }, [autoRun]);

  const serve = useCallback(async (req: BridgeExportRequest) => {
    const h = hostRef.current;
    const activity: EditorActivity = {
      view: h.view,
      openProjectId: h.project?.id ?? null,
      exporting: h.exporting || running.current !== null,
      themePreviewRunning: h.themePreviewRunning.current,
      exportModalOpen: h.showExport,
      pointerDown: pointerDown.current,
      fieldEditing: fields.current.editing(document.activeElement as FocusLike | null, Date.now()),
    };
    const refusal = bridgeExportRefusal(req, activity);
    if (refusal) {
      await invoke("bridge_export_accept", {
        id: req.id,
        answer: { accepted: false, ...refusal },
      }).catch(() => {});
      return;
    }
    const abort = new AbortController();
    const job = { id: req.id, abort, by: "user" };
    running.current = job;
    const accepted = await invoke<boolean>("bridge_export_accept", {
      id: req.id,
      answer: { accepted: true },
    }).catch(() => false);
    if (!accepted) {
      running.current = null;
      return;
    }
    const tracker = new BridgeProgressTracker(Date.now, req.verify ? 2 : 1);
    let lastReport = 0;
    let lastStage = "";
    const report = () => {
      const progress = tracker.snapshot();
      const now = Date.now();
      if (progress.stage === lastStage && now - lastReport < REPORT_MS) return;
      lastReport = now;
      lastStage = progress.stage;
      setOverlay((o) => (o && o.id === req.id ? { ...o, progress } : o));
      void invoke("bridge_export_progress", { id: req.id, progress }).catch(() => {});
    };
    setOverlay({
      id: req.id,
      verify: req.verify === true,
      client: req.client ?? null,
      progress: tracker.snapshot(),
      cancelling: false,
    });
    report();
    const startingFormat = useEditorStore.getState().format;
    let result: Record<string, unknown> | BridgeFailure;
    try {
      result = await runRequest(
        req,
        hostRef,
        activity,
        abort,
        startingFormat.name,
        tracker,
        report,
      );
    } catch (e) {
      result = bridgeFailureFor(e, abort.signal.aborted, job.by);
    } finally {
      running.current = null;
      setOverlay(null);
      // The run may have switched the editor's aspect; give back the one the person was working in.
      void hostRef.current.commitFormat(startingFormat);
    }
    if (isBridgeFailure(result) && result.code === "cancelled") {
      result = { ...result, cancelled: true, by: job.by };
    }
    await invoke("bridge_export_finish", { id: req.id, result }).catch((e) =>
      console.warn("[bridge-export] couldn't report the result:", e),
    );
  }, []);

  useEffect(() => {
    if (autoRun) return;
    // A reload mid-export lost its runner: Rust fails that export instead of leaving kb waiting.
    void invoke("bridge_export_reset").catch(() => {});
    const offExport = listen<unknown>("kookaburra://bridge-export", (event) => {
      const req = parseBridgeExportRequest(event.payload);
      if (req) void serve(req);
    });
    const offCancel = listen<{ id?: string; by?: string }>(
      "kookaburra://bridge-export-cancel",
      (event) => {
        const job = running.current;
        if (!job || job.id !== event.payload.id || job.abort.signal.aborted) return;
        job.by = event.payload.by ?? "client";
        job.abort.abort();
        setOverlay((o) => (o && o.id === job.id ? { ...o, cancelling: true } : o));
      },
    );
    return () => {
      void offExport.then((off) => off());
      void offCancel.then((off) => off());
    };
  }, [autoRun, serve]);

  const cancel = useCallback(() => {
    const job = running.current;
    if (!job || job.abort.signal.aborted) return;
    job.by = "user";
    job.abort.abort();
    setOverlay((o) => (o ? { ...o, cancelling: true } : o));
  }, []);

  return { overlay, cancel };
}
