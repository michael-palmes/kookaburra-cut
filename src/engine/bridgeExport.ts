/** Claude's export through the bridge (docs/agent-kit.md, "Export through the bridge"): the request read as the Export modal would set it (`choiceForRequest`), the progress the editor reports (fps and ETA from the export's own callbacks, never read by the render) and the answer's shape. The editor side is `ui/useBridgeExport.ts`; Rust owns the slot, the file's hash and the response. */

import type { ExportPresetDoc } from "../export/presetSchema";
import {
  aspectForPreset,
  choiceForRequest,
  type VideoChoice,
  type VideoExportSelection,
} from "../export/selection";
import {
  type DeterminismResult,
  EXPORT_PREAMBLE_STEPS,
  type ExportOptions,
  type ExportProgress,
} from "./exporter";
import { normalExportFrameCount } from "./exportFrames";
import { type AspectName, FORMATS } from "./format";
import { type LoadedProject, sceneFileStem } from "./project";
import { GpuStallError } from "./readback";
import { changedSourceFiles, type SourceStamp } from "./sourceBaseline";

/** How App's `runVideoExport` runs a selection: the Export button and the bridge differ only here, and none of it reaches the bytes. */
export interface VideoRun {
  abort: AbortController;
  /** `setting`: the button honours Keep exports in project; `project`: always the project's exports/ folder. */
  destination: "setting" | "project";
  /** Render twice and compare (`verifyDeterminism`) instead of once. */
  verify?: boolean;
  onProgress?: (p: ExportProgress) => void;
  onPrepareStep?: (step: number) => void;
}

export interface VideoRunResult {
  /** The file the run wrote (null for a verify, whose file Rust records). */
  path: string | null;
  options: ExportOptions;
  verify?: DeterminismResult;
}

/** The `kookaburra://bridge-export` payload Rust emits to the main window. */
export interface BridgeExportRequest {
  id: string;
  project: string;
  projectPath?: string | null;
  client?: string | null;
  aspect?: string | null;
  preset?: string | null;
  fps?: number | null;
  shortEdge?: number | null;
  /** null = the app's setting, as the modal opens. */
  posterFrame?: boolean | null;
  verify?: boolean;
  /** kb's view of the sources: lowercase SHA-256 per `project.json` and `scenes/*` file. */
  sources?: Record<string, string> | null;
}

export type BridgeFailureCode =
  | "busy"
  | "editing"
  | "notOpen"
  | "wrongProject"
  | "invalid"
  | "refused"
  | "stale"
  | "cancelled"
  | "gpuStalled"
  | "gpuWedged"
  | "failed";

export interface BridgeFailure {
  ok: false;
  code: BridgeFailureCode;
  error: string;
  hint?: string;
  busy?: boolean;
  retryAfterMs?: number;
  cancelled?: boolean;
  by?: string;
  reloadFailed?: boolean;
}

const OPEN_HINT = "ask the user to open this project in Kookaburra Cut, then rerun";

function failure(
  code: BridgeFailureCode,
  error: string,
  extra: Partial<BridgeFailure> = {},
): BridgeFailure {
  return { ok: false, code, error, ...extra };
}

function busy(code: "busy" | "editing", error: string, hint: string): BridgeFailure {
  return failure(code, error, { busy: true, hint, retryAfterMs: 5_000 });
}

export function isBridgeFailure(value: unknown): value is BridgeFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The event payload, or null when it is not one. */
export function parseBridgeExportRequest(raw: unknown): BridgeExportRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const project = str(r.project);
  if (!id || !project) return null;
  const sources =
    typeof r.sources === "object" && r.sources !== null
      ? Object.fromEntries(
          Object.entries(r.sources as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : null;
  return {
    id,
    project,
    projectPath: str(r.projectPath),
    client: str(r.client),
    aspect: str(r.aspect),
    preset: str(r.preset),
    fps: num(r.fps),
    shortEdge: num(r.shortEdge),
    posterFrame: typeof r.posterFrame === "boolean" ? r.posterFrame : null,
    verify: r.verify === true,
    sources,
  };
}

/** What the editor is doing when a request arrives. */
export interface EditorActivity {
  view: string;
  openProjectId: string | null;
  /** An export, Verify or stills export holds the canvas. */
  exporting: boolean;
  themePreviewRunning: boolean;
  exportModalOpen: boolean;
  pointerDown: boolean;
  fieldFocused: boolean;
}

/** The acceptance rules: only the project open in the editor, and only while the person is not mid-edit and nothing else holds the canvas. */
export function bridgeExportRefusal(
  req: BridgeExportRequest,
  editor: EditorActivity,
): BridgeFailure | null {
  if (editor.view !== "editor" || !editor.openProjectId) {
    return failure(
      "notOpen",
      `Kookaburra Cut isn't showing ${req.project}; kb export only exports the project open in the editor`,
      { hint: OPEN_HINT },
    );
  }
  if (editor.openProjectId !== req.project) {
    return failure(
      "wrongProject",
      `Kookaburra Cut has ${editor.openProjectId} open, not ${req.project}; kb export only exports the project open in the editor`,
      { hint: OPEN_HINT },
    );
  }
  if (editor.exporting || editor.themePreviewRunning) {
    return busy(
      "busy",
      "Kookaburra Cut is already exporting (or previewing a theme)",
      "rerun once it finishes",
    );
  }
  if (editor.exportModalOpen) {
    return busy(
      "editing",
      "the user has the Export window open",
      "rerun in a moment, or ask the user to close the Export window",
    );
  }
  if (editor.pointerDown || editor.fieldFocused) {
    return busy(
      "editing",
      editor.pointerDown
        ? "the user is dragging in Kookaburra Cut"
        : "the user is typing in a field in Kookaburra Cut",
      "rerun in a moment, once the user has finished the edit",
    );
  }
  return null;
}

/** The modal's choice and aspect for a request: the preset row, or Custom seeded as the panel seeds it; the aspect defaults to the editor's, kept when the preset allows it. */
export function resolveBridgeChoice(
  req: BridgeExportRequest,
  editorAspect: AspectName,
  findPreset: (id: string) => ExportPresetDoc | undefined,
): { choice: VideoChoice; aspect: AspectName } | BridgeFailure {
  const choice = choiceForRequest(
    { preset: req.preset ?? null, fps: req.fps ?? null, shortEdge: req.shortEdge ?? null },
    findPreset,
  );
  if ("error" in choice) return failure("invalid", choice.error);
  const allowed =
    choice.kind === "preset" && choice.doc.allowedAspects?.length
      ? choice.doc.allowedAspects
      : null;
  if (req.aspect) {
    if (!(req.aspect in FORMATS)) {
      return failure(
        "invalid",
        `unknown aspect "${req.aspect}" (use ${Object.keys(FORMATS).join(", ")})`,
      );
    }
    const aspect = req.aspect as AspectName;
    if (allowed && !allowed.includes(aspect)) {
      return failure(
        "invalid",
        `the ${req.preset} preset exports ${allowed.join(", ")}, not ${aspect}`,
      );
    }
    return { choice, aspect };
  }
  return {
    choice,
    aspect: choice.kind === "preset" ? aspectForPreset(choice.doc, editorAspect) : editorAspect,
  };
}

/** VideoToolbox encodes are not bit-exact (decisions.md), so Verify refuses them. */
export function isHardwareLane(sel: VideoExportSelection): boolean {
  return sel.encode?.codec?.endsWith("_videotoolbox") ?? false;
}

/** The export's stage as the progress file names it. */
export type BridgeStage =
  | "syncing"
  | "preparing"
  | "render"
  | "pass1"
  | "pass2"
  | "finalising"
  | "hashing";

export interface BridgeProgress {
  stage: BridgeStage;
  run: number;
  runs: number;
  prepareStep: number;
  prepareSteps: number;
  prepareLabel: string;
  frame: number;
  total: number;
  percent: number;
  renderFps: number | null;
  elapsedMs: number;
  etaMs: number | null;
}

/** How far back the render rate looks. */
const FPS_WINDOW_MS = 10_000;

/** Turns the export's callbacks into progress reports with a render rate and an ETA; UI-side only, the render never reads it. */
export class BridgeProgressTracker {
  private stage: BridgeStage = "syncing";
  private run = 1;
  private prepareStep = 0;
  private frame = 0;
  private total = 0;
  private samples: [number, number][] = [];
  private readonly startedAt: number;

  constructor(
    private readonly now: () => number,
    private readonly runs = 1,
  ) {
    this.startedAt = now();
  }

  setStage(stage: BridgeStage): void {
    this.stage = stage;
  }

  onPrepareStep(step: number): void {
    this.prepareStep = step;
    if (this.stage === "syncing" || this.stage === "preparing") this.stage = "preparing";
  }

  onProgress(p: ExportProgress): void {
    if (p.stage !== "render") {
      this.stage = p.stage;
      this.frame = p.frame;
      this.total = p.total;
      return;
    }
    // A verify's second render restarts at frame 1.
    if (p.frame < this.frame && this.run < this.runs) {
      this.run += 1;
      this.samples = [];
    }
    this.frame = p.frame;
    this.total = p.total;
    this.stage = p.total > 0 && p.frame >= p.total ? "finalising" : "render";
    const t = this.now();
    this.samples.push([t, p.frame]);
    while (this.samples.length > 2 && t - this.samples[0][0] > FPS_WINDOW_MS) this.samples.shift();
  }

  renderFps(): number | null {
    if (this.samples.length < 2) return null;
    const [t0, f0] = this.samples[0];
    const [t1, f1] = this.samples[this.samples.length - 1];
    if (t1 <= t0 || f1 <= f0) return null;
    return ((f1 - f0) * 1000) / (t1 - t0);
  }

  snapshot(): BridgeProgress {
    const fps = this.renderFps();
    const left = Math.max(0, this.total - this.frame) + (this.runs - this.run) * this.total;
    const done = this.total > 0 ? (this.run - 1 + this.frame / this.total) / this.runs : 0;
    return {
      stage: this.stage,
      run: this.run,
      runs: this.runs,
      prepareStep: this.prepareStep,
      prepareSteps: EXPORT_PREAMBLE_STEPS.length,
      prepareLabel: EXPORT_PREAMBLE_STEPS[this.prepareStep] ?? EXPORT_PREAMBLE_STEPS[0],
      frame: this.frame,
      total: this.total,
      percent: Math.round(Math.min(1, done) * 1000) / 10,
      renderFps: fps === null ? null : Math.round(fps * 100) / 100,
      elapsedMs: Math.max(0, Math.round(this.now() - this.startedAt)),
      etaMs: fps && this.stage === "render" ? Math.round((left / fps) * 1000) : null,
    };
  }
}

/** The project files a stamp list names, as kb hashes them. */
export function stampFiles(stamps: readonly SourceStamp[]): string[] {
  return stamps.map((s) => s.file).sort();
}

/** What the sync step reads, injected so it can be tested without the app. */
export interface SourceSync {
  settleWrites(): Promise<void>;
  stamps(): Promise<SourceStamp[]>;
  /** The reload poll's per-file baseline (null until its first tick). */
  baseline(): ReadonlyMap<string, string> | null;
  loadInFlight(): boolean;
  /** The persistent live-reload failure, if the last reload failed. */
  reloadError(): string | null;
  hashes(files: string[]): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
  aborted(): boolean;
}

export const SYNC_TIMEOUT_MS = 20_000;
const SYNC_POLL_MS = 200;

/** Lands every source change before the export reads the project: queued app writes settle, the reload poll picks up outside changes (waiting up to 20 s), a failed reload refuses, and kb's own view of the files must still match the disk. */
export async function syncSources(
  sources: Record<string, string> | null | undefined,
  io: SourceSync,
): Promise<BridgeFailure | null> {
  await io.settleWrites();
  const deadline = io.now() + SYNC_TIMEOUT_MS;
  let stamps: SourceStamp[];
  for (;;) {
    if (io.aborted()) return failure("cancelled", "the export was cancelled, so nothing was saved");
    stamps = await io.stamps();
    const baseline = io.baseline();
    const pending = baseline ? changedSourceFiles(baseline, stamps) : stampFiles(stamps);
    if (pending.length === 0 && !io.loadInFlight()) break;
    if (io.now() >= deadline) {
      return failure(
        "stale",
        `Kookaburra Cut has not reloaded ${pending.length ? pending.join(", ") : "the project"} after ${SYNC_TIMEOUT_MS / 1000} s, so it would export an older version`,
        { hint: "rerun in a moment", retryAfterMs: 5_000 },
      );
    }
    await io.sleep(SYNC_POLL_MS);
  }
  const reloadError = io.reloadError();
  if (reloadError) {
    return failure(
      "stale",
      `the last reload failed, so Kookaburra Cut still shows an older version: ${reloadError.split("\n")[0]}`,
      { hint: "fix the file the error names (./kb check), then rerun", reloadFailed: true },
    );
  }
  if (!sources) return null;
  const expected = Object.keys(sources).sort();
  const onDisk = stampFiles(stamps);
  const added = onDisk.filter((f) => !(f in sources));
  const missing = expected.filter((f) => !onDisk.includes(f));
  if (added.length || missing.length) {
    return failure(
      "stale",
      `the project's files changed after kb read them (${[...added.map((f) => `new ${f}`), ...missing.map((f) => `gone ${f}`)].join(", ")})`,
      { hint: "rerun kb export", retryAfterMs: 2_000 },
    );
  }
  const hashes = await io.hashes(expected);
  const changed = expected.filter((f, i) => hashes[i] !== sources[f]);
  if (changed.length) {
    return failure("stale", `${changed.join(", ")} changed after kb read them`, {
      hint: "rerun kb export",
      retryAfterMs: 2_000,
    });
  }
  return null;
}

/** encode.rs `out_dims`: the short edge scaled down to the target, even, never up. */
export function outputSize(
  width: number,
  height: number,
  shortEdge: number | undefined,
): [number, number] {
  if (!shortEdge) return [width, height];
  const short = Math.min(width, height);
  if (shortEdge >= short) return [width, height];
  const even = (v: number) => Math.round(v / 2) * 2;
  const f = shortEdge / short;
  return [even(width * f), even(height * f)];
}

/** The editor's facts for the answer; Rust adds the path, size, hash and flash report. */
export function bridgeExportFacts(
  project: Pick<LoadedProject, "slots" | "sceneFiles" | "totalMs">,
  sel: VideoExportSelection,
  options: Pick<ExportOptions, "fps" | "format" | "codec">,
  verify: DeterminismResult | null,
  warnings: string[],
): Record<string, unknown> {
  const encode = sel.encode;
  const posterFrame = encode?.posterFrame === true;
  const frames = normalExportFrameCount(project.totalMs, options.fps) + (posterFrame ? 1 : 0);
  const [width, height] = outputSize(
    options.format.width,
    options.format.height,
    encode?.scaleShortEdgeTo,
  );
  return {
    ok: true,
    aspect: sel.aspect,
    preset: sel.presetId,
    lane: encode ? "spec" : "frozen",
    codec: encode?.codec ?? options.codec ?? "libx264",
    fps: options.fps,
    width,
    height,
    posterFrame,
    frames,
    durationMs: Math.round((frames * 1000 * 100) / options.fps) / 100,
    totalMs: project.totalMs,
    timeline: project.slots.map((slot, i) => ({
      index: slot.index,
      stem: sceneFileStem(project.sceneFiles[i] ?? ""),
      startMs: slot.startMs,
      endMs: slot.endMs,
      durationMs: slot.durationMs,
      transitionIn: slot.transitionIn ? { ...slot.transitionIn } : null,
    })),
    verify: verify
      ? {
          identical: verify.identical,
          hashA: verify.hashA,
          hashB: verify.hashB,
          ...(verify.divergentCount !== undefined
            ? { divergentCount: verify.divergentCount, divergentRanges: verify.divergentRanges }
            : {}),
        }
      : null,
    warnings,
  };
}

/** A failed run's answer code: a cancel, a GPU stall (a blank frame reruns; a lost context needs a restart), or a plain failure. */
export function bridgeFailureFor(error: unknown, aborted: boolean, by: string): BridgeFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (aborted) {
    return failure("cancelled", "the export was cancelled, so nothing was saved", {
      cancelled: true,
      by,
    });
  }
  if (error instanceof GpuStallError || message.startsWith("GPU stalled")) {
    const wedged =
      error instanceof GpuStallError
        ? error.reason === "contextLost"
        : /context was lost/.test(message);
    return wedged
      ? failure("gpuWedged", message, { hint: "ask the user to quit and reopen Kookaburra Cut" })
      : failure("gpuStalled", message, { hint: "rerun kb export", retryAfterMs: 10_000 });
  }
  if (/already in progress/.test(message)) {
    return busy("busy", message, "rerun once the other export finishes");
  }
  return failure("failed", message);
}
