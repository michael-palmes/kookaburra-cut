import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { LinearFilter, type Object3D, type Scene, SRGBColorSpace, Texture } from "three";
import { useEditorStore } from "../store/editorStore";
import { allChunks, chunkCount, chunkOf, chunksForFrames, windowChunks } from "./clipChunks";
import { isExporting, subscribeExporting } from "./exportState";
import { noteClipReferenced } from "./perfProbe";
import { resolveAssetPath } from "./project";
import { ProjectIdContext } from "./sceneContext";

/** VideoClip frame pipeline: source videos are extracted by the ffmpeg sidecar to a deterministic CFR PNG sequence (cached under `$APPDATA`, keyed by source hash, filled in 120-frame chunks on demand), then sampled per frame off the manual clock with a small LRU so a long 4K clip never holds thousands of textures in memory. See docs/determinism.md. */

/** Geometry + location of an extracted clip's frame sequence (returned by the Rust `clip_info`). */
export interface ClipInfo {
  /** Absolute cache dir under `$APPDATA` holding `frame-%05d.png`. */
  cacheDir: string;
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  /** The source's content hash (the entry's cache key). */
  sha?: string;
  /** Chunks already on disk; absent means the whole clip is. */
  chunks?: number[];
  /** Chunks whose preview JPEGs are on disk. */
  previewChunks?: number[];
}

/** One consumer's frame demand over scene time: its window (null means it has no scene and always advances) and its frame mapping. */
export interface ClipDemand {
  window: readonly [number, number] | null;
  frameAt: (localMs: number, info: ClipInfo) => number;
  /** Where its scene starts on the project timeline (0 without a scene), so a one-frame capture can find its local time. */
  sceneStartMs?: number;
  /** The frame it holds while its scene is away from the playhead (bound, so its chunk is needed too). */
  heldFrame?: number;
}

/** A conform job naming this clip's file before the mezzanine exists: the clip waits, with no extraction, no error and no texture. */
export interface ClipPendingState {
  slug: string;
  rel: string;
  frame: number;
  total: number;
  /** 0..1 once the job reports its length, else null. */
  progress: number | null;
}

/** Registry record for one source clip: its preparation promise and, once ready, its loader. */
interface ClipEntry {
  /** `<lane>:<absolute source path>`. */
  key: string;
  /** Absolute source path (the registry key also carries the lane). */
  srcAbs: string;
  lane: ClipLane;
  promise: Promise<ClipInfo>;
  info?: ClipInfo;
  frames?: ClipFrames;
  error?: string;
  /** Content hash at extraction time; the invalidation sweep compares against a re-hash. */
  sha?: string;
  /** The file's `<size>-<mtimeNs>` read before that hash; the sweep re-hashes only when it moved. */
  rev?: string | null;
  /** Mounted consumers and how to read their current demand. */
  consumers: Map<object, () => ClipDemand>;
}

/** Each path's `<size>-<mtimeNs>` (null when unreadable); null for all of them when the command fails. */
async function fileRevisions(paths: string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  try {
    const revs = await invoke<(string | null)[]>("file_revisions", { paths });
    if (Array.isArray(revs) && revs.length === paths.length) return revs;
  } catch {
    // Unreadable stamps fall back to the full re-hash.
  }
  return paths.map(() => null);
}

/** Number of decoded frame textures kept resident per clip (LRU window). */
const LRU_CAPACITY = 12;

/** Which frame set a consumer binds: `full` = the deterministic PNGs (export, paused, scrubbing); `preview` = the small JPEG set decoded during preview playback. */
export type ClipTier = "full" | "preview";

/** Keyed by `<lane>:<absolute source path>` so multiple `<VideoClip>`s of one source share extraction per lane. */
const registry = new Map<string, ClipEntry>();

/** Decode lane: `hw` (VideoToolbox) is the everyday default; `sw` is the software decode the standing baselines were recorded from. The two are NOT pixel-identical, so each owns its own cache dir and deterministic-codec exports pin to `sw`. */
export type ClipLane = "hw" | "sw";

let activeLane: ClipLane = "hw";

const HARDWARE_EXPORT_CODECS = new Set([
  "h264_videotoolbox",
  "hevc_videotoolbox",
  "prores_videotoolbox",
]);

/** The everyday (non-export) lane; follows the Settings hardware-video toggle. */
let everydayLane: ClipLane = "hw";

/** Fast-draft (hardware) export codecs read the everyday lane; deterministic codecs read the software lane so Verify and the baselines stay anchored. */
export function laneForCodec(codec: string | undefined): ClipLane {
  return codec && HARDWARE_EXPORT_CODECS.has(codec) ? everydayLane : "sw";
}

export function everydayClipLane(): ClipLane {
  return everydayLane;
}

/** Apply the Settings hardware-video toggle; deferred to the export's own lane restore when a run is in flight (the registry must not bump mid-loop). */
export function setHardwareVideo(enabled: boolean): void {
  everydayLane = enabled ? "hw" : "sw";
  if (!isExporting()) setClipLane(everydayLane);
}

/** Switch the active decode lane; mounted consumers re-register against it via the registry version bump. */
export function setClipLane(lane: ClipLane): void {
  if (lane === activeLane) return;
  activeLane = lane;
  notifyRegistry();
}

// A freshly added video's first frames take a while and the device screen stays black meanwhile, so the stage shows an honest "Preparing video" chip driven by this counter; UI-only plumbing, no clock reads or render-path change.
let extracting = 0;
const extractionListeners = new Set<() => void>();
// Deferred notify: registerClip is legal during React render, and a synchronous store notification there would set state mid-render of another component.
function notifyExtraction() {
  queueMicrotask(() => {
    for (const listener of extractionListeners) listener();
  });
}
function bumpExtracting(delta: number) {
  extracting += delta;
  notifyExtraction();
}
/** Subscribe to extraction-count changes (useSyncExternalStore shape). */
export function subscribeClipExtraction(listener: () => void): () => void {
  extractionListeners.add(listener);
  return () => extractionListeners.delete(listener);
}
export function clipExtractionCount(): number {
  return extracting;
}

/** Per-extraction ffmpeg progress (frames written vs the run's length), keyed per native request. */
interface ExtractProgress {
  frame: number;
  total: number;
}
const extractionProgress = new Map<string, ExtractProgress>();
let progressSeq = 0;

/** Aggregate 0..1 progress across in-flight extractions, or null before any has reported (the chip falls back to indeterminate). */
export function clipExtractionProgress(): number | null {
  if (extractionProgress.size === 0) return null;
  let frames = 0;
  let total = 0;
  for (const p of extractionProgress.values()) {
    frames += p.frame;
    total += p.total;
  }
  return total > 0 ? Math.min(1, frames / total) : null;
}

/** Counts one native job toward the chip for as long as it runs. */
async function tracked<T>(run: () => Promise<T>): Promise<T> {
  bumpExtracting(1);
  try {
    return await run();
  } finally {
    bumpExtracting(-1);
  }
}

/** A clip's frames could not be extracted: the export fails on it rather than capturing a black screen. */
export class ClipChunkError extends Error {}

/** A conform the clip waited on failed, so its file never appeared. */
export class ClipConformError extends Error {}

/** A frame load dropped because its consumer asked for another frame while the chunk extracted. */
export class ClipLoadSuperseded extends Error {}

function clipName(srcAbs: string): string {
  return srcAbs.split("/").pop() ?? srcAbs;
}

/** Extracts missing chunks for one entry (the native side runs consecutive ones as one pass and makes a second request for the same chunk wait for the first). */
function chunkSource(entry: ClipEntry, info: ClipInfo): ChunkSource {
  return {
    label: clipName(entry.srcAbs),
    ensure: (chunks) =>
      tracked(async () => {
        const progressKey = `${entry.key}#${++progressSeq}`;
        const onProgress = new Channel<ExtractProgress>();
        onProgress.onmessage = (p) => {
          extractionProgress.set(progressKey, p);
          notifyExtraction();
        };
        try {
          await invoke("ensure_clip_chunks", {
            srcAbs: entry.srcAbs,
            cacheDir: info.cacheDir,
            chunks,
            onProgress,
          });
        } finally {
          extractionProgress.delete(progressKey);
          notifyExtraction();
        }
      }),
    previews: (chunk) => invoke("ensure_clip_previews", { cacheDir: info.cacheDir, chunk }),
  };
}

/** Readies an entry: waits out a conform still writing its file, then has the native side hash it and know its frame count (the decode-only pass on a cold entry). Frames themselves extract chunk by chunk as consumers ask. */
async function prepare(entry: ClipEntry): Promise<ClipInfo> {
  // Stamped before hashing, so a write landing between the two reads as moved on the next sweep.
  let [rev] = await fileRevisions([entry.srcAbs]);
  if (rev === null && (await awaitConformLanding(entry.srcAbs))) {
    [rev] = await fileRevisions([entry.srcAbs]);
  }
  const info = await tracked(() =>
    invoke<ClipInfo>("clip_info", {
      srcAbs: entry.srcAbs,
      sha: null,
      hardware: entry.lane === "hw",
    }),
  );
  entry.info = info;
  entry.sha = info.sha;
  entry.rev = rev;
  entry.frames = new ClipFrames(info, chunkSource(entry, info));
  schedulePins();
  return info;
}

/** Registers a clip in the active lane (idempotent) and starts preparing it once per unique source+lane; safe to call during render, it does no work when the entry already exists. */
export function registerClip(srcAbs: string): ClipEntry {
  const lane = activeLane;
  const key = `${lane}:${srcAbs}`;
  const existing = registry.get(key);
  if (existing) return existing;
  const entry: ClipEntry = {
    key,
    srcAbs,
    lane,
    consumers: new Map(),
    promise: undefined as unknown as Promise<ClipInfo>,
  };
  noteClipReferenced(key);
  entry.promise = prepare(entry).catch((e) => {
    entry.error = String(e);
    throw e;
  });
  // Marks the stored rejection as handled (consumers read `entry.error` or catch on await); without this, a failed extraction (e.g. a clip briefly resolved against the wrong project's assets during a project swap) logs an unhandled promise rejection.
  entry.promise.catch(() => {});
  registry.set(key, entry);
  return entry;
}

/** Requests the chunks holding `frames` for an entry that has its info; resolves once they are on disk. */
export async function ensureFrames(entry: ClipEntry, frames: Iterable<number>): Promise<void> {
  const info = await entry.promise;
  if (!entry.frames) return;
  await entry.frames.ensureChunks(chunksForFrames(frames, info.frameCount));
}

// Registry version: bumped on eviction so mounted consumers re-register against a fresh extraction. Never bumps during export (both eviction paths are UI events the export state blocks or defers).
let registryVersion = 0;
const registryListeners = new Set<() => void>();
/** Subscribe to registry evictions (useSyncExternalStore shape). */
export function subscribeClipRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}
export function clipRegistryVersion(): number {
  return registryVersion;
}

function evictEntry(key: string, entry: ClipEntry): void {
  registry.delete(key);
  entry.frames?.retire();
  schedulePins();
}

function notifyRegistry(): void {
  registryVersion++;
  for (const listener of registryListeners) listener();
}

/** Evicts every registered clip (the clip-extraction cache was cleared on disk); consumers re-extract. */
export function evictAllClips(): void {
  if (registry.size === 0) return;
  for (const [key, entry] of registry) evictEntry(key, entry);
  notifyRegistry();
}

/** The media-changed sweep: evicts every settled clip whose file changed on disk (an edit render or a replace overwrote it) plus any failed extraction, so consumers re-extract instead of serving stale frames. Rev-gated: one stat per clip, and a re-hash only where the size or modified time moved (a moved stamp over the same bytes just adopts the new stamp). */
export async function invalidateChangedClips(): Promise<void> {
  const entries = [...registry.entries()].filter(([, entry]) => entry.info || entry.error);
  const revs = await fileRevisions(entries.map(([, entry]) => entry.srcAbs));
  const evicted = await Promise.all(
    entries.map(async ([key, entry], i) => {
      if (!entry.error) {
        const rev = revs[i];
        if (rev !== null && rev === entry.rev) return false;
        try {
          if ((await invoke<string>("hash_file", { path: entry.srcAbs })) === entry.sha) {
            entry.rev = rev;
            return false;
          }
        } catch {
          // Unreadable now (deleted or moved): evict so consumers surface the error.
        }
      }
      evictEntry(key, entry);
      return true;
    }),
  );
  if (evicted.some(Boolean)) notifyRegistry();
}

// ── Consumers, pins and the export barrier ──────────────────────────────────────

/** Records a mounted consumer's demand (read lazily, so it always reflects the consumer's latest mapping); returns the unpublish. */
export function publishClipConsumer(
  entry: ClipEntry,
  owner: object,
  demand: () => ClipDemand,
): () => void {
  entry.consumers.set(owner, demand);
  schedulePins();
  return () => {
    if (entry.consumers.get(owner) === demand) entry.consumers.delete(owner);
    schedulePins();
  };
}

/** Entries a running export or capture needs; held until the export state drops. */
const exportHeld = new Set<ClipEntry>();
subscribeExporting(() => {
  if (isExporting()) return;
  exportHeld.clear();
  schedulePins();
});

let pinsScheduled = false;
let lastPins: string | null = null;

/** Tells the native cache which entries this window needs (its mounted clips plus a running export's), so eviction never takes them. */
function schedulePins(): void {
  if (pinsScheduled) return;
  pinsScheduled = true;
  queueMicrotask(() => {
    pinsScheduled = false;
    const dirs = new Set<string>();
    for (const entry of registry.values()) {
      if (entry.info && entry.consumers.size > 0) dirs.add(entry.info.cacheDir);
    }
    for (const entry of exportHeld) if (entry.info) dirs.add(entry.info.cacheDir);
    const sorted = [...dirs].sort();
    const key = sorted.join("\n");
    if (key === lastPins) return;
    lastPins = key;
    Promise.resolve()
      .then(() => invoke("set_clip_cache_pins", { dirs: sorted }))
      .catch(() => {
        lastPins = null;
      });
  });
}

/** A demand's chunks over its window, or at one capture instant (`atMs`, project time) when only that frame renders. */
function addDemand(chunks: Set<number>, demand: ClipDemand, info: ClipInfo, atMs?: number): void {
  if (atMs !== undefined) {
    const local = atMs - (demand.sceneStartMs ?? 0);
    const window = demand.window;
    if (!window || (local >= window[0] && local <= window[1])) {
      for (const c of chunksForFrames([demand.frameAt(local, info)], info.frameCount))
        chunks.add(c);
    }
  } else if (!demand.window) {
    for (const c of allChunks(info.frameCount)) chunks.add(c);
  } else {
    const [from, to] = demand.window;
    windowChunks((ms) => demand.frameAt(ms, info), from, to, info.frameCount, chunks);
  }
  if (demand.heldFrame !== undefined) {
    for (const c of chunksForFrames([demand.heldFrame], info.frameCount)) chunks.add(c);
  }
}

/** How long an export waits for a clip whose conform is still writing its file. */
export const CONFORM_WAIT_MS = 15 * 60_000;

/** An entry's info for the export barrier: a clip still conforming is waited on with status lines, failing the run with a clear message past the bound or when its conform fails. Other failures degrade the clip as they always have. */
async function settleForExport(
  entry: ClipEntry,
  onStatus: (line: string) => void,
  waitMs: number,
): Promise<ClipInfo | undefined> {
  const name = clipName(entry.srcAbs);
  let lastStep = -1;
  const report = () => {
    const state = clipPendingState(entry.srcAbs);
    if (!state) return;
    const step = state.progress === null ? 0 : Math.floor(state.progress * 10);
    if (step === lastStep) return;
    lastStep = step;
    const pct = state.progress === null ? "" : ` (${Math.round(state.progress * 100)}%)`;
    onStatus(`[clips] waiting for "${name}" to finish conforming${pct}`);
  };
  const unsubscribe = subscribeClipPending(report);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    report();
    const timedOut = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), waitMs);
    });
    const outcome = await Promise.race([
      entry.promise.then(
        (info) => info,
        (e: unknown) => (e instanceof ClipConformError ? e : undefined),
      ),
      timedOut,
    ]);
    if (outcome instanceof ClipConformError) throw outcome;
    if (outcome !== "timeout") return outcome;
    if (clipPendingState(entry.srcAbs)) {
      throw new Error(
        `"${name}" is still conforming after ${Math.round(waitMs / 60_000)} minutes; export again once it finishes.`,
      );
    }
    return await entry.promise.catch(() => undefined);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/**
 * The export preamble's clip barrier, run twice (docs/determinism.md "Embedded video"). Registers every known and declared source in the active lane, holds them pinned for the run, waits out pending conforms, then extracts exactly the chunks each consumer needs: the declared slot demands (sidecar devices, media and layered screenshots, derived before anything mounts), plus on the `consumers` pass every mounted consumer's own window and held frame. A declared source whose timing is unknown and that no mounted consumer covers takes the whole clip. A one-frame capture (`atMs`) takes only the frames that instant shows. Chunk failures throw, so the export fails loudly instead of capturing black.
 */
export async function prepareExportClips(
  declared: ReadonlyMap<string, readonly ClipDemand[]>,
  options: {
    consumers: boolean;
    atMs?: number;
    onStatus?: (line: string) => void;
    conformWaitMs?: number;
  },
): Promise<void> {
  // A lane switch may not have re-rendered consumers yet, so register every known source in the active lane here rather than trusting React's flush timing.
  const sources = new Set([...registry.values()].map((e) => e.srcAbs));
  for (const src of declared.keys()) sources.add(src);
  const entries = [...sources].map((src) => registerClip(src));
  for (const entry of entries) exportHeld.add(entry);
  schedulePins();
  const onStatus = options.onStatus ?? ((line: string) => console.warn(line));
  await Promise.all(
    entries.map(async (entry) => {
      const info = await settleForExport(entry, onStatus, options.conformWaitMs ?? CONFORM_WAIT_MS);
      const frames = entry.frames;
      if (!info || !frames) return;
      const chunks = new Set<number>();
      const listed = declared.get(entry.srcAbs);
      for (const demand of listed ?? []) addDemand(chunks, demand, info, options.atMs);
      let known = (listed?.length ?? 0) > 0;
      if (options.consumers) {
        for (const read of entry.consumers.values()) {
          addDemand(chunks, read(), info, options.atMs);
          known = true;
        }
        // A capture's late mount extracts its one frame inside the frame barrier instead.
        if (!known && listed && options.atMs === undefined) {
          for (const c of allChunks(info.frameCount)) chunks.add(c);
        }
      }
      if (chunks.size > 0) await frames.ensureChunks(chunks);
    }),
  );
  schedulePins();
}

// ── Pending conforms ────────────────────────────────────────────────────────────

const pendingBySrc = new Map<string, ClipPendingState>();
const landingWaiters = new Map<string, Set<(error?: Error) => void>>();
const pendingListeners = new Set<() => void>();

function notifyPending(): void {
  queueMicrotask(() => {
    for (const listener of pendingListeners) listener();
  });
}

/** Whether a clip is waiting on a conform still writing its file, with the job's progress; null once it lands (or when it never was). Consumers show their own placeholder meanwhile. */
export function clipPendingState(srcAbs: string): ClipPendingState | null {
  return pendingBySrc.get(srcAbs) ?? null;
}

/** Subscribe to pending-conform changes (useSyncExternalStore shape). */
export function subscribeClipPending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** The pending state for `srcAbs`, read reactively. */
export function useClipPendingState(srcAbs: string): ClipPendingState | null {
  return useSyncExternalStore(subscribeClipPending, () => clipPendingState(srcAbs));
}

interface ConformJobPayload {
  slug: string;
  rel: string;
  frame: number;
  total: number;
}

function setPending(srcAbs: string, job: ConformJobPayload): void {
  pendingBySrc.set(srcAbs, {
    slug: job.slug,
    rel: job.rel,
    frame: job.frame,
    total: job.total,
    progress: job.total > 0 ? Math.min(1, job.frame / job.total) : null,
  });
  notifyPending();
}

function settleLanding(srcAbs: string, error?: Error): void {
  const waiters = landingWaiters.get(srcAbs);
  if (!waiters) return;
  landingWaiters.delete(srcAbs);
  for (const done of waiters) done(error);
}

function pendingMatching(slug: unknown, rel: (r: string) => boolean): string[] {
  return [...pendingBySrc.entries()]
    .filter(([, state]) => state.slug === slug && rel(state.rel))
    .map(([src]) => src);
}

let conformWatch: Promise<void> | null = null;

/** Follows conform jobs app-wide: progress updates pending clips, a landing (`done`, or the `media-changed` that follows it) releases them, a failure fails them. Installed once, on the first pending clip. */
function watchConforms(): Promise<void> {
  conformWatch ??= (async () => {
    try {
      await listen<{
        slug: string;
        rel: string;
        stage: string;
        frame: number;
        total: number;
        error: string | null;
      }>("kookaburra://conform-progress", ({ payload }) => {
        for (const src of pendingMatching(payload.slug, (r) => r === payload.rel)) {
          if (payload.stage === "done") settleLanding(src);
          else if (payload.stage === "failed") {
            settleLanding(
              src,
              new ClipConformError(
                `Conforming "${payload.rel}" failed${payload.error ? `: ${payload.error}` : ""}`,
              ),
            );
          } else setPending(src, payload);
        }
      });
      await listen<{ slug?: string; paths?: string[]; origin?: string } | null>(
        "kookaburra://media-changed",
        ({ payload }) => {
          if (payload?.origin !== "conform" || !Array.isArray(payload.paths)) return;
          const paths = payload.paths;
          for (const src of pendingMatching(payload.slug, (r) => paths.includes(r))) {
            settleLanding(src);
          }
        },
      );
    } catch (e) {
      console.warn("[clips] conform events unavailable; pending clips poll instead:", e);
    }
  })();
  return conformWatch;
}

/** Re-asks the native side this often while a clip is pending, in case an event was missed. */
const PENDING_POLL_MS = 5000;

/** Holds a missing file that a conform job is writing until the job lands; returns whether it waited. A file nobody is writing returns at once, so `clip_info` reports it missing as before. */
async function awaitConformLanding(srcAbs: string): Promise<boolean> {
  await watchConforms();
  const job = await invoke<ConformJobPayload | null>("clip_conform_pending", { srcAbs }).catch(
    () => null,
  );
  if (!job) return false;
  setPending(srcAbs, job);
  let poll: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => (error ? reject(error) : resolve());
      let waiters = landingWaiters.get(srcAbs);
      if (!waiters) {
        waiters = new Set();
        landingWaiters.set(srcAbs, waiters);
      }
      waiters.add(done);
      const check = () => {
        poll = setTimeout(async () => {
          const still = await invoke<ConformJobPayload | null>("clip_conform_pending", {
            srcAbs,
          }).catch(() => null);
          if (still) {
            setPending(srcAbs, still);
            check();
          } else settleLanding(srcAbs);
        }, PENDING_POLL_MS);
      };
      check();
    });
  } finally {
    clearTimeout(poll);
    pendingBySrc.delete(srcAbs);
    notifyPending();
  }
  return true;
}

/** Awaits every VideoClip in the scene having its current frame's texture uploaded before the export captures pixels; mirrors `awaitTextSync` for troika text via each VideoClip's published `userData.videoFrameReady`. */
export function awaitVideoFramesReady(scene: Scene): Promise<void> {
  const pending: Promise<void>[] = [];
  scene.traverse((obj: Object3D) => {
    const ready = (obj.userData as { videoFrameReady?: () => Promise<void> }).videoFrameReady;
    if (typeof ready === "function") pending.push(ready());
    // Permanent guard: a bound clip texture whose bitmap detached before its first GPU upload samples black; `useClipTexture` uploads eagerly at bind so this should never fire, if it does the export is capturing black screens.
    const mesh = obj as { material?: { map?: { image?: { width?: number } } } };
    const img = mesh.material?.map?.image;
    if (img && img.width === 0) {
      console.error(`[clips] DETACHED bitmap bound on "${obj.name || obj.type}" at capture`);
    }
  });
  return Promise.all(pending).then(() => undefined);
}

/** A pending consumer's wait for its first bind, driven by the consumer: `extraction` follows the entry it now waits on, `start` marks a bind run beginning, and `settle` marks one completing uncancelled, its extraction failing, or the consumer unmounting. */
export interface FirstBind {
  extraction: Promise<unknown>;
  started: Promise<void>;
  done: Promise<void>;
  start: () => void;
  settle: () => void;
}

export function createFirstBind(extraction: Promise<unknown>): FirstBind {
  let start!: () => void;
  let settle!: () => void;
  const started = new Promise<void>((r) => {
    start = r;
  });
  const done = new Promise<void>((r) => {
    settle = r;
  });
  return {
    extraction,
    started,
    done,
    start,
    settle: () => {
      start();
      settle();
    },
  };
}

/** How long a consumer may take to start its first bind once its extraction settles: a re-render, never a decode, so only a stalled tree reaches it. */
export const FIRST_BIND_STALL_MS = 30_000;

/** A still-pending consumer's readiness: its extraction, then its first completed bind, so a clip registered after the preamble's extract barrier (a screen behind its model's suspense) can never pass a capture in its pending state. Extraction may take minutes, so only the gap after it is bounded, by one timer (hidden pages throttle spin chains); a bind that never starts fails the run instead of hanging it. */
export async function pendingFrameReady(
  firstBind: FirstBind,
  src: string,
  stallMs = FIRST_BIND_STALL_MS,
): Promise<void> {
  for (;;) {
    const extraction = firstBind.extraction;
    await Promise.race([extraction.catch(() => {}), firstBind.done]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((r) => {
      timer = setTimeout(() => r("stalled"), stallMs);
    });
    const outcome = await Promise.race([firstBind.started.then(() => "started" as const), stalled]);
    clearTimeout(timer);
    if (outcome === "started") break;
    // A consumer that moved on to a newer extraction (a lane switch) waits on that one instead.
    if (firstBind.extraction === extraction) {
      throw new Error(`Video "${src}" extracted but never bound its first frame.`);
    }
  }
  await firstBind.done;
}

/** Extraction attempts per chunk before its failure sticks for the entry's lifetime (a replaced file or a cleared cache makes a fresh entry). */
const MAX_CHUNK_ATTEMPTS = 2;

/** How a ClipFrames reaches the native chunk cache. */
interface ChunkSource {
  /** The clip's file name, for messages. */
  label: string;
  ensure: (chunks: number[]) => Promise<void>;
  previews: (chunk: number) => Promise<void>;
}

/** Streams a clip's frames from disk as three.js textures with an LRU cache (via the fs plugin + `createImageBitmap`, decoding deterministically); a frame's chunk is extracted first when it is not on disk yet. Consumers pin their requested frame synchronously and their bound frame until replaced, since evicting and closing a bitmap that's still in flight or bound throws WebGL INVALID_VALUE and renders white. */
export class ClipFrames {
  private readonly cache = new Map<string, Texture>();
  private order: string[] = [];
  private readonly loading = new Map<string, Promise<Texture>>();
  /** Consumer → its protected frames (see the pinning note above); keys are tier-qualified. */
  private readonly pinned = new Map<object, { bound?: string; loading?: string }>();
  /** Chunks whose PNGs are on disk. */
  private readonly ready: Set<number>;
  private readonly previewReady: Set<number>;
  private readonly ensuring = new Map<number, Promise<void>>();
  private readonly failures = new Map<number, { count: number; error: ClipChunkError }>();
  private readonly previewing = new Set<number>();

  constructor(
    private readonly info: ClipInfo,
    private readonly source?: ChunkSource,
  ) {
    this.ready = new Set(info.chunks ?? allChunks(info.frameCount));
    this.previewReady = new Set(info.previewChunks ?? []);
  }

  /** Whether frame `i`'s chunk is on disk (binding it needs no extraction). */
  hasFrame(i: number): boolean {
    return this.ready.has(chunkOf(i));
  }

  /** Whether frame `i`'s preview JPEG exists; playback may bind the `preview` tier for it. */
  hasPreviews(i: number): boolean {
    return this.previewReady.has(chunkOf(i));
  }

  /** Starts generating frame `i`'s chunk of preview JPEGs once its PNGs exist (preview playback only; never awaited). */
  requestPreviews(i: number): void {
    const chunk = chunkOf(i);
    if (!this.source || this.previewReady.has(chunk) || this.previewing.has(chunk)) return;
    if (!this.ready.has(chunk)) return;
    this.previewing.add(chunk);
    this.source
      .previews(chunk)
      .then(() => this.previewReady.add(chunk))
      .catch((e) => console.warn("[clips] preview generation failed:", e))
      .finally(() => this.previewing.delete(chunk));
  }

  /** Requests every missing chunk among `chunks` (one native call for the ones nobody has asked for yet); resolves once all are on disk. A chunk that failed twice fails at once from then on, so a broken file never respawns ffmpeg every tick. */
  ensureChunks(chunks: Iterable<number>): Promise<void> {
    const total = chunkCount(this.info.frameCount);
    const waits: Promise<void>[] = [];
    const missing: number[] = [];
    for (const c of new Set(chunks)) {
      if (c < 0 || c >= total || this.ready.has(c)) continue;
      const failed = this.failures.get(c);
      if (failed && failed.count >= MAX_CHUNK_ATTEMPTS) return Promise.reject(failed.error);
      const inflight = this.ensuring.get(c);
      if (inflight) waits.push(inflight);
      else missing.push(c);
    }
    if (missing.length > 0) {
      const label = this.source?.label ?? this.info.cacheDir;
      const request = (
        this.source
          ? this.source.ensure(missing)
          : Promise.reject(new Error("no extraction source"))
      ).then(
        () => {
          for (const c of missing) this.ready.add(c);
        },
        (e: unknown) => {
          const error = new ClipChunkError(
            `Could not extract the frames of "${label}" (chunks ${missing.join(", ")}): ${String(e)}`,
          );
          for (const c of missing) {
            this.failures.set(c, { count: (this.failures.get(c)?.count ?? 0) + 1, error });
          }
          throw error;
        },
      );
      const inflight = request.finally(() => {
        for (const c of missing) if (this.ensuring.get(c) === inflight) this.ensuring.delete(c);
      });
      for (const c of missing) this.ensuring.set(c, inflight);
      waits.push(inflight);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private ensureFrame(i: number): Promise<void> {
    const chunk = chunkOf(i);
    if (this.ready.has(chunk)) return Promise.resolve();
    if (isExporting()) {
      console.warn(
        `[clips] export bound frame ${i} of "${this.source?.label}" outside its prepared chunks; extracting chunk ${chunk}`,
      );
    }
    return this.ensureChunks([chunk]);
  }

  private path(i: number, tier: ClipTier): string {
    const stem = `frame-${String(i).padStart(5, "0")}`;
    return tier === "preview"
      ? `${this.info.cacheDir}/preview/${stem}.jpg`
      : `${this.info.cacheDir}/${stem}.png`;
  }

  private key(i: number, tier: ClipTier): string {
    return `${tier}:${i}`;
  }

  /** Pin `i` as `owner`'s in-flight request. Call BEFORE `get(i)`, synchronously. */
  request(owner: object, i: number, tier: ClipTier = "full"): void {
    const pins = this.pinned.get(owner) ?? {};
    pins.loading = this.key(i, tier);
    this.pinned.set(owner, pins);
  }

  /** Mark `i` as `owner`'s bound frame (its previous bound frame becomes evictable). */
  markBound(owner: object, i: number, tier: ClipTier = "full"): void {
    const pins = this.pinned.get(owner) ?? {};
    pins.bound = this.key(i, tier);
    if (pins.loading === pins.bound) pins.loading = undefined;
    this.pinned.set(owner, pins);
  }

  /** Drop all of `owner`'s pins (call on unmount). */
  unpin(owner: object): void {
    this.pinned.delete(owner);
  }

  private isPinned(key: string): boolean {
    for (const pins of this.pinned.values()) {
      if (pins.bound === key || pins.loading === key) return true;
    }
    return false;
  }

  /** Resolve the texture for frame `i` in `tier`, extracting its chunk and decoding + caching it if not already resident. */
  get(i: number, tier: ClipTier = "full"): Promise<Texture> {
    const key = this.key(i, tier);
    const hit = this.cache.get(key);
    if (hit) {
      const img = hit.image as ImageBitmap | undefined;
      if (!img || img.width > 0) {
        this.touch(key);
        return Promise.resolve(hit);
      }
      // The bitmap was detached under a live reference (evicted while bound; pinning prevents this now, but self-heal by reloading rather than rendering white).
      const at = this.order.indexOf(key);
      if (at >= 0) this.order.splice(at, 1);
      this.cache.delete(key);
      hit.dispose();
    }
    let pending = this.loading.get(key);
    if (!pending) {
      const load = this.load(i, tier);
      pending = load;
      this.loading.set(key, load);
      // A failed load is retried by the next request rather than cached.
      load.catch(() => {
        if (this.loading.get(key) === load) this.loading.delete(key);
      });
    }
    return pending;
  }

  private async read(i: number, tier: ClipTier): Promise<ArrayBuffer> {
    // Reads via the Rust command (not the fs plugin) so it works regardless of webview fs scope; `invoke` resolves a raw byte response to an ArrayBuffer.
    return invoke<ArrayBuffer>("read_clip_frame", { path: this.path(i, tier) });
  }

  private async load(i: number, tier: ClipTier): Promise<Texture> {
    const key = this.key(i, tier);
    if (tier === "full" && !this.hasFrame(i)) {
      await this.ensureFrame(i);
      // Playback moved on while the chunk extracted: skip the decode nobody will bind.
      if (!this.isPinned(key)) throw new ClipLoadSuperseded(`frame ${i} is no longer requested`);
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await this.read(i, tier);
    } catch (e) {
      if (tier !== "full" || !this.source) throw e;
      // Another app instance can evict a chunk this one still marks ready; extract it again, once.
      this.ready.delete(chunkOf(i));
      await this.ensureFrame(i);
      try {
        buffer = await this.read(i, tier);
      } catch (again) {
        throw new ClipChunkError(
          `Frame ${i} of "${this.source.label}" is missing after extracting its chunk: ${String(again)}`,
        );
      }
    }
    // `imageOrientation: "flipY"` + `flipY = false` is the reliable upright combo for ImageBitmap textures in three (the texture's own flipY flag is ignored for bitmaps).
    const bitmap = await createImageBitmap(new Blob([buffer]), {
      imageOrientation: "flipY",
    });
    const tex = new Texture(bitmap);
    // Stamps which clip frame this texture holds so the exporter's Verify diagnostics can record what was actually bound at render time (see exporter.sampleBoundClipFrame).
    tex.userData.clipFrame = i;
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    this.cache.set(key, tex);
    this.loading.delete(key);
    this.touch(key);
    this.evict();
    return tex;
  }

  private touch(key: string): void {
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(key);
  }

  private evict(): void {
    // Oldest-first, skipping pinned frames (a bound frame must never be closed under the renderer); if everything old is pinned we simply hold more than LRU_CAPACITY, bounded by the number of mounted consumers.
    let scan = 0;
    while (this.order.length > LRU_CAPACITY && scan < this.order.length) {
      const key = this.order[scan];
      if (this.isPinned(key)) {
        scan++;
        continue;
      }
      this.order.splice(scan, 1);
      disposeTexture(this.cache.get(key));
      this.cache.delete(key);
    }
  }

  /** Post-eviction cleanup: closes unpinned frames now; pinned ones stay alive for still-mounted consumers (closing a bound bitmap renders white) and fall to GC once they re-bind against the replacement entry. */
  retire(): void {
    this.order = this.order.filter((key) => {
      if (this.isPinned(key)) return true;
      disposeTexture(this.cache.get(key));
      this.cache.delete(key);
      return false;
    });
  }

  dispose(): void {
    for (const tex of this.cache.values()) disposeTexture(tex);
    this.cache.clear();
    this.order = [];
    this.loading.clear();
    this.pinned.clear();
  }
}

function disposeTexture(tex?: Texture): void {
  if (!tex) return;
  (tex.image as ImageBitmap | undefined)?.close?.();
  tex.dispose();
}

/** Resolves a project-relative clip `src` for the active project and subscribes the caller to its preparation: registers on-demand and forces a re-render when it resolves, so the primitive can read `entry.info`/`entry.frames` synchronously (including inside the export loop's `flushSync`). */
export function useClipEntry(src: string): ClipEntry {
  // Resolves against the project that owns this mounted scene (ProjectIdContext), not the live store: during a project switch the store's projectId flips one render before old scenes unmount, which used to resolve this clip against the wrong project's assets.
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const srcAbs = resolveAssetPath(contextProjectId ?? storeProjectId, src);
  // Re-registers after an eviction (the invalidation sweep), picking up the fresh extraction.
  useSyncExternalStore(subscribeClipRegistry, clipRegistryVersion);
  const entry = registerClip(srcAbs);
  const [, force] = useState(0);
  // Keyed on what this render saw: an extraction settling between render and effect must still re-render, or the consumer (and a capture awaiting its first bind) stays pending.
  const settled = Boolean(entry.info || entry.error);
  useEffect(() => {
    if (settled) return;
    let alive = true;
    entry.promise
      .finally(() => {
        if (alive) force((n) => n + 1);
      })
      // `.finally()` returns a derived promise that re-rejects with the original reason; without this catch a failed extraction escapes as an unhandledrejection (which the boot trap escalates and once closed the app). Errors surface via `entry.error`.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry, settled]);
  return entry;
}
