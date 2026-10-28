import type { FrameRect } from "../toolkit/frame/frameLayout";
import type { ClipInfo, ClipLane } from "./clips";
import type { ExportOptions } from "./exporter";
import type { GizmoDomain } from "./gizmoRegistry";
import type { GlCensus } from "./glContexts";
import type { SceneLoadPhase } from "./loadDiagnostics";
import type { PerfRow } from "./perfProbe";
import type { LoadedProject } from "./project";
import type { RenderStateFingerprint } from "./renderFingerprint";
import type { StillsSettings } from "./stillsExport";

/**
 * The stage protocol: the one typed, versioned seam between a window realm (chrome, the
 * zustand stores, every native effect) and its stage worker (three, react-three-fiber, the
 * toolkit, the compiled scene modules). Scene code runs only in the worker, which has no
 * Tauri IPC; the worker never names a filesystem path, it asks for what it needs by
 * project-relative name and the window resolves it against the open project.
 *
 * Shapes: `WindowRequest` expects exactly one `WorkerReply` with the same `id`; `WindowNotice`
 * and `WorkerNotice` are fire-and-forget; `WorkerRequest` is answered by one `WindowReply`.
 * Everything crossing is structured-clone safe; frame bytes travel as transferred buffers.
 * See docs/architecture.md ("The stage worker") and docs/determinism.md.
 */
export const STAGE_PROTOCOL_VERSION = 1;

export type StageRole = "editor" | "present" | "render";

/** A scene entry the worker compiles: a bundled module (the app's own glob) or workspace source text the window read. */
export type SceneCompileEntry =
  | { kind: "bundled"; path: string }
  | { kind: "source"; file: string; source: string; token: number };

export type SceneCompileResult =
  | { ok: true; id: string; durationMs: number; key: string }
  | { ok: false; phase: SceneLoadPhase; message: string };

/** `LoadedProject` as the worker receives it: every field is data, the components are named by the keys the compile step returned. */
export interface StageProject extends Omit<LoadedProject, "scenes" | "persistent"> {
  scenes: {
    id: string;
    durationMs: number;
    key: string | null;
    errorCard?: { file: string; message: string };
  }[];
  persistentKey?: string;
  /** Every project-relative asset the worker may load, resolved by the window: images, HDRs and panel sources, keyed by their clean relative path. */
  assetUrls: Record<string, string>;
}

export interface StageSize {
  width: number;
  height: number;
  dpr: number;
}

export interface Gizmo2DTargetFrame {
  key: string;
  domain: "text" | "chart" | "layeredScreenshot";
  sceneIndex: number;
  itemId: string;
  side?: "b";
  drawn: boolean;
  panel: boolean;
  /** Four corners (top-left, top-right, bottom-right, bottom-left in local terms) then the pivot, in world space. */
  world: [number, number, number][];
  /** The same five points in NDC through the live camera; absent for a panel item. */
  ndc?: [number, number][];
  /** Depth-aware points for a screenshot stack. */
  worldPoints?: [number, number, number][];
}

export interface CameraFrame {
  matrixWorld: number[];
  projectionMatrix: number[];
  projectionMatrixInverse: number[];
  fov: number;
  aspect: number;
}

export interface GizmoPickerSummary {
  domain: GizmoDomain;
  itemId: string;
  sceneIndex: number;
}

export interface CommitStamps {
  clockMs: number;
  shutterSeq: number;
  holdsVersion: number;
  /** The LoadedProject identity the canvas tree last committed, as the window's load sequence number. */
  projectSeq: number | null;
  primaryHosts: number;
}

/** The window's zustand stores the canvas tree reads (data fields only, actions stay realm-local). */
export type MirroredStore =
  | "editor"
  | "ui"
  | "effects"
  | "cameraEdit"
  | "compareEdit"
  | "lightingEdit"
  | "lightEdit"
  | "deviceEdit"
  | "objectEdit"
  | "chartEdit"
  | "imageEdit"
  | "layeredScreenshotEdit"
  | "presentDeck";

export type WindowRequest =
  | { type: "configure"; id: number; size: StageSize; frameloop: "demand" | "never" }
  | { type: "compileScenes"; id: number; projectId: string; entries: SceneCompileEntry[] }
  | { type: "loadProject"; id: number; project: StageProject | null; seq: number }
  | { type: "awaitHosts"; id: number; expected: number }
  | { type: "settle"; id: number; projectId: string }
  | { type: "exportBegin"; id: number; opts: StageExportOptions }
  | {
      type: "exportFrame";
      id: number;
      frame: number;
      tMs: number;
      buffer: ArrayBuffer | null;
      fingerprint: boolean;
    }
  | { type: "exportEnd"; id: number }
  | { type: "captureFrame"; id: number; opts: StageExportOptions; tMs: number }
  | { type: "stillsBegin"; id: number; opts: StageExportOptions; settings: StillsSettings }
  | { type: "stillsPage"; id: number; page: number }
  | { type: "stillsEnd"; id: number }
  | { type: "snapshot"; id: number; tMs: number | null; width: number; format: "png" | "jpeg" }
  | { type: "perfApply"; id: number; pass: string | null }
  | { type: "perfStats"; id: number }
  | { type: "hitTest"; id: number; ndcX: number; ndcY: number; domain?: GizmoDomain }
  | { type: "census"; id: number }
  | { type: "forceContextLoss"; id: number }
  | { type: "releasePools"; id: number };

/** `ExportOptions` minus the window-only `signal`. */
export type StageExportOptions = Omit<ExportOptions, "signal">;

export type WorkerReply =
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string; stall?: string };

export type WindowNotice =
  | {
      type: "init";
      version: number;
      role: StageRole;
      canvas: OffscreenCanvas;
      size: StageSize;
      frameloop: "demand" | "never";
      dev: boolean;
    }
  | { type: "clock"; currentMs?: number; durationMs?: number }
  | { type: "store"; name: MirroredStore; patch: Record<string, unknown> }
  | { type: "pointer"; event: StagePointerEvent }
  | { type: "cutout"; rect: FrameRect | null }
  | { type: "assetsChanged"; projectId: string; urls: Record<string, string> }
  | { type: "clipConform"; srcKey: string; state: unknown }
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

export interface StagePointerEvent {
  kind: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "pointerleave" | "wheel";
  /** Canvas-relative CSS pixels. */
  x: number;
  y: number;
  button: number;
  buttons: number;
  pointerId: number;
  pointerType: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  deltaX?: number;
  deltaY?: number;
}

export type WorkerNotice =
  | { type: "ready"; version: number; gl: string }
  | { type: "log"; level: "warn" | "error" | "info"; text: string }
  | { type: "fatal"; text: string }
  | { type: "commit"; stamps: CommitStamps }
  | { type: "frame"; targets: Gizmo2DTargetFrame[]; camera: CameraFrame }
  | { type: "pickers"; pickers: GizmoPickerSummary[] }
  | { type: "store"; name: MirroredStore; patch: Record<string, unknown> }
  | { type: "cursor"; cursor: string }
  | { type: "contextLost"; lossClass: string }
  | { type: "progress"; id: number; value: unknown }
  | {
      type: "exportFrameBytes";
      id: number;
      rgba: Uint8Array;
      boundClipFrame: number;
      fingerprint: RenderStateFingerprint | null;
    };

/** What the worker may ask the window for: every item names a project-relative path or a handle the window issued; the window resolves, validates and performs the native call. */
export type WorkerRequest =
  | { type: "clipInfo"; id: number; projectId: string; rel: string; lane: ClipLane }
  | {
      type: "clipChunks";
      id: number;
      cacheDir: string;
      chunk: number;
      lane: ClipLane;
      count?: number;
    }
  | { type: "clipPreviews"; id: number; cacheDir: string; chunk: number }
  | { type: "clipFrame"; id: number; cacheDir: string; index: number; tier: "full" | "preview" }
  | { type: "clipPins"; id: number; dirs: string[] }
  | { type: "clipConformPending"; id: number; projectId: string; rel: string }
  | { type: "fontBytes"; id: number; url: string }
  | { type: "emojiRaster"; id: number; op: string; payload: unknown };

export type WindowReply = Extract<WindowNotice, { type: "reply" }>;

export type ToWorker = WindowRequest | WindowNotice;
export type ToWindow = WorkerReply | WorkerNotice | WorkerRequest;

export type ClipInfoReply = ClipInfo;
export type SettleProgress = number;
export type PerfStatsReply = Pick<PerfRow, "drawCalls" | "triangles" | "texturesInMemory">;
export type CensusReply = GlCensus;
