import type { PerspectiveCamera } from "three";
import type { FrameRect } from "../toolkit/frame/frameLayout";
import type { ExportOptions } from "./exporter";
import type { GizmoDomain } from "./gizmoRegistry";
import type { GlCensus } from "./glContexts";
import type { MemoryCensus } from "./memoryCensus";
import type { PerfRow } from "./perfProbe";
import type { LoadedProject } from "./project";
import type { SceneTextBox } from "./rangeRun";
import type { RenderStateFingerprint } from "./renderFingerprint";
import type {
  CameraFrame,
  CommitStamps,
  Gizmo2DTargetFrame,
  GizmoPickerSummary,
  SceneCompileEntry,
  SceneCompileResult,
  StageExportOptions,
} from "./stageProtocol";
import type { StillPageDigest, StillsSettings } from "./stillsExport";

/** Where the worker's boot stands now. `ready` settles once; a worker that reports after its window fails and then recovers moves here from failed to ready with `late` set. */
export type StageBoot =
  | { status: "starting" }
  | { status: "ready"; late: boolean }
  | { status: "failed"; error: Error };

/** What the window realm's engine modules can ask of the stage worker (`stage/stageClient.ts` implements it). Engine code reaches the stage through `stage()` so it never imports the client, which would drag the worker bootstrap into the engine graph. */
export interface StageHandle {
  /** Settles with the first boot outcome; `boot()` follows a late recovery. */
  readonly ready: Promise<void>;
  boot(): StageBoot;
  subscribeBoot(listener: () => void): () => void;
  /** The last commit stamps the canvas tree posted. */
  stamps(): CommitStamps;
  subscribeStamps(listener: () => void): () => void;
  /** The LoadedProject the stage last committed (identity: the object this window handed it). */
  committedProject(): LoadedProject | null;
  /** The last rendered frame's gizmo targets and camera. */
  frame(): { targets: Gizmo2DTargetFrame[]; camera: CameraFrame | null };
  subscribeFrame(listener: () => void): () => void;
  pickers(): GizmoPickerSummary[];
  subscribePickers(listener: () => void): () => void;
  /** A camera whose matrices are the stage camera's last frame, for window-side projection maths; null before the first frame. */
  camera(): PerspectiveCamera | null;
  compileScenes(projectId: string, entries: SceneCompileEntry[]): Promise<SceneCompileResult[]>;
  loadProject(project: LoadedProject | null, seq: number): Promise<void>;
  /** Loads with a fresh sequence number: the window's project swap path. */
  applyProject(project: LoadedProject | null): Promise<number>;
  awaitHosts(expected: number): Promise<void>;
  settle(projectId: string, onProgress?: (completed: number) => void): Promise<void>;
  exportBegin(
    opts: StageExportOptions,
    onPrepareStep?: (step: number) => void,
  ): Promise<{ total: number }>;
  exportFrame(
    frame: number,
    tMs: number,
    poster: boolean,
    buffer: ArrayBuffer | null,
    fingerprint: boolean,
  ): Promise<{
    rgba: Uint8Array;
    boundClipFrame: number;
    fingerprint: RenderStateFingerprint | null;
  }>;
  exportEnd(): Promise<void>;
  /** Holds the worker's export flag across a Verify's two passes. */
  holdExport(on: boolean): Promise<void>;
  captureFrame(
    opts: StageExportOptions,
    tMs: number,
  ): Promise<{ rgba: Uint8Array; width: number; height: number }>;
  /** A ranged render (engine/rangeRun.ts): one preamble over the span, then a frame at a time, buffers ping-ponging as an export's do. */
  rangeBegin(opts: StageExportOptions, spanMs: [number, number]): Promise<void>;
  rangeFrame(
    index: number,
    tMs: number,
    buffer: ArrayBuffer | null,
    texts: boolean,
  ): Promise<{ rgba: Uint8Array; texts?: SceneTextBox[] }>;
  rangeEnd(): Promise<void>;
  stillsBegin(
    opts: StageExportOptions,
    settings: StillsSettings,
    onPrepareStep?: (step: number) => void,
  ): Promise<{ total: number; pageTimesMs: number[]; warnings: unknown[]; pageMeta: string[] }>;
  stillsPage(page: number): Promise<{
    body: Uint8Array;
    headers: Record<string, string>;
    pageHash: string;
    digest: StillPageDigest;
  }>;
  stillsEnd(): Promise<void>;
  snapshot(tMs: number | null, width: number, format: "png" | "jpeg"): Promise<Uint8Array | null>;
  perfRun(): Promise<PerfRow[]>;
  perfColdWaits(): Promise<{ referenced: number; bound: number; waits: number[] }>;
  hitTest(
    ndcX: number,
    ndcY: number,
    domain?: GizmoDomain,
    claim?: boolean,
  ): Promise<GizmoPickerSummary | null>;
  census(): Promise<GlCensus>;
  /** The memory probe's count of three's residency and the clip frame cache, from the realm that holds them. */
  memoryCensus(): Promise<MemoryCensus>;
  forceContextLoss(): Promise<void>;
  releasePools(): Promise<void>;
  invalidateChangedClips(): Promise<void>;
  evictAllClips(): Promise<void>;
  setCutout(rect: FrameRect | null): void;
  /** Preview-only knobs the worker's render path reads (engine/previewMedia.ts, the clip lane); never pixels an export sees. */
  previewFlags(flags: {
    clipStride?: number;
    motionBlurSamples?: number;
    playbackActive?: boolean;
    slideshowActive?: boolean;
    hardwareVideo?: boolean;
  }): void;
  /** The memory probe's `clip-cache=N` lever; nothing else changes it. */
  setClipCacheCapacity(n: number): void;
  /** Loss count on the stage canvas since the worker started. */
  contextLosses(): number;
  subscribeContextLost(listener: () => void): () => void;
  /** The canvas element the stage draws into (its client box is the stage rect). */
  readonly element: HTMLCanvasElement;
}

let current: StageHandle | null = null;

export function setStage(handle: StageHandle | null): void {
  current = handle;
}

/** The window's stage, or null before one is attached (the theme editor keeps a main-thread canvas and never asks). */
export function stageOrNull(): StageHandle | null {
  return current;
}

export function stage(): StageHandle {
  if (!current) throw new Error("Export bridge not mounted: the stage is not ready.");
  return current;
}

/** `ExportOptions` without the window-only abort signal, for the protocol. */
export function stageExportOptions(opts: ExportOptions): StageExportOptions {
  const { signal: _signal, ...rest } = opts;
  return rest;
}
