import { invoke } from "@tauri-apps/api/core";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { LinearFilter, type Object3D, type Scene, SRGBColorSpace, Texture } from "three";
import { useEditorStore } from "../store/editorStore";
import { isExporting } from "./exportState";
import { resolveAssetPath } from "./project";
import { ProjectIdContext } from "./sceneContext";

/** VideoClip frame pipeline: source videos are pre-extracted by the ffmpeg sidecar to a deterministic CFR PNG sequence (cached under `$APPDATA`, keyed by source hash), then sampled per frame off the manual clock with a small LRU so a long 4K clip never holds thousands of textures in memory. See docs/determinism.md. */

/** Geometry + location of an extracted clip's frame sequence (returned by the Rust command). */
export interface ClipInfo {
  /** Absolute cache dir under `$APPDATA` holding `frame-%05d.png`. */
  cacheDir: string;
  frameCount: number;
  width: number;
  height: number;
  fps: number;
}

/** Registry record for one source clip: its extraction promise and, once ready, its loader. */
interface ClipEntry {
  /** Absolute source path (the registry key also carries the lane). */
  srcAbs: string;
  promise: Promise<ClipInfo>;
  info?: ClipInfo;
  frames?: ClipFrames;
  error?: string;
  /** Content hash at extraction time; the invalidation sweep compares against a re-hash. */
  sha?: string;
}

/** Number of decoded frame textures kept resident per clip (LRU window). */
const LRU_CAPACITY = 12;

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

// A freshly added video's first extraction takes a while and the device screen stays black meanwhile, so the stage shows an honest "Preparing video" chip driven by this counter; UI-only plumbing, no clock reads or render-path change.
let extracting = 0;
const extractionListeners = new Set<() => void>();
function bumpExtracting(delta: number) {
  extracting += delta;
  // Deferred notify: registerClip is legal during React render, and a synchronous store notification there would set state mid-render of another component.
  queueMicrotask(() => {
    for (const listener of extractionListeners) listener();
  });
}
/** Subscribe to extraction-count changes (useSyncExternalStore shape). */
export function subscribeClipExtraction(listener: () => void): () => void {
  extractionListeners.add(listener);
  return () => extractionListeners.delete(listener);
}
export function clipExtractionCount(): number {
  return extracting;
}

async function extract(srcAbs: string, lane: ClipLane): Promise<{ info: ClipInfo; sha: string }> {
  const sha = await invoke<string>("hash_file", { path: srcAbs });
  const info = await invoke<ClipInfo>("extract_clip_frames", {
    srcAbs,
    sha,
    hardware: lane === "hw",
  });
  return { info, sha };
}

/** Registers a clip for on-demand extraction in the active lane (idempotent); kicks off the sidecar extraction once per unique source+lane and memoizes the result. Safe to call during render, it does no work when the entry already exists. */
export function registerClip(srcAbs: string): ClipEntry {
  const lane = activeLane;
  const key = `${lane}:${srcAbs}`;
  const existing = registry.get(key);
  if (existing) return existing;
  const entry: ClipEntry = { srcAbs, promise: undefined as unknown as Promise<ClipInfo> };
  entry.promise = extract(srcAbs, lane)
    .then(({ info, sha }) => {
      entry.info = info;
      entry.sha = sha;
      entry.frames = new ClipFrames(info);
      return info;
    })
    .catch((e) => {
      entry.error = String(e);
      throw e;
    });
  // Marks the stored rejection as handled (consumers read `entry.error` or catch on await); without this, a failed extraction (e.g. a clip briefly resolved against the wrong project's assets during a project swap) logs an unhandled promise rejection.
  entry.promise.catch(() => {});
  bumpExtracting(1);
  entry.promise.catch(() => {}).finally(() => bumpExtracting(-1));
  registry.set(key, entry);
  return entry;
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

/** The media-changed sweep: re-hashes every settled clip and evicts those whose file changed on disk (an edit render overwrote it) plus any failed extraction, so consumers re-extract instead of serving stale frames. */
export async function invalidateChangedClips(): Promise<void> {
  const evicted = await Promise.all(
    [...registry.entries()].map(async ([key, entry]) => {
      if (!entry.info && !entry.error) return false; // still extracting, already fresh
      if (!entry.error) {
        try {
          if ((await invoke<string>("hash_file", { path: entry.srcAbs })) === entry.sha)
            return false;
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

/** Awaits extraction of every registered clip; called in the export preamble (beside font preload) so all frame sequences exist on disk before frame 0, the "await all assets before frame 0" determinism rule. */
export function preextractClips(): Promise<void> {
  // A lane switch may not have re-rendered consumers yet, so register every known source in the active lane here rather than trusting React's flush timing.
  const sources = new Set([...registry.values()].map((e) => e.srcAbs));
  for (const src of sources) registerClip(src);
  return Promise.all([...registry.values()].map((e) => e.promise.catch(() => {}))).then(
    () => undefined,
  );
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

/** Streams a clip's frames from disk as three.js textures with an LRU cache (via the fs plugin + `createImageBitmap`, decoding deterministically); consumers pin their requested frame synchronously and their bound frame until replaced, since evicting and closing a bitmap that's still in flight or bound throws WebGL INVALID_VALUE and renders white. */
export class ClipFrames {
  private readonly cache = new Map<number, Texture>();
  private order: number[] = [];
  private readonly loading = new Map<number, Promise<Texture>>();
  /** Consumer → its protected frames (see the pinning note above). */
  private readonly pinned = new Map<object, { bound?: number; loading?: number }>();

  constructor(private readonly info: ClipInfo) {}

  private path(i: number): string {
    return `${this.info.cacheDir}/frame-${String(i).padStart(5, "0")}.png`;
  }

  /** Pin `i` as `owner`'s in-flight request. Call BEFORE `get(i)`, synchronously. */
  request(owner: object, i: number): void {
    const pins = this.pinned.get(owner) ?? {};
    pins.loading = i;
    this.pinned.set(owner, pins);
  }

  /** Mark `i` as `owner`'s bound frame (its previous bound frame becomes evictable). */
  markBound(owner: object, i: number): void {
    const pins = this.pinned.get(owner) ?? {};
    pins.bound = i;
    if (pins.loading === i) pins.loading = undefined;
    this.pinned.set(owner, pins);
  }

  /** Drop all of `owner`'s pins (call on unmount). */
  unpin(owner: object): void {
    this.pinned.delete(owner);
  }

  private isPinned(i: number): boolean {
    for (const pins of this.pinned.values()) {
      if (pins.bound === i || pins.loading === i) return true;
    }
    return false;
  }

  /** Resolve the texture for frame `i`, decoding + caching it if not already resident. */
  get(i: number): Promise<Texture> {
    const hit = this.cache.get(i);
    if (hit) {
      const img = hit.image as ImageBitmap | undefined;
      if (!img || img.width > 0) {
        this.touch(i);
        return Promise.resolve(hit);
      }
      // The bitmap was detached under a live reference (evicted while bound; pinning prevents this now, but self-heal by reloading rather than rendering white).
      const at = this.order.indexOf(i);
      if (at >= 0) this.order.splice(at, 1);
      this.cache.delete(i);
      hit.dispose();
    }
    let pending = this.loading.get(i);
    if (!pending) {
      pending = this.load(i);
      this.loading.set(i, pending);
    }
    return pending;
  }

  private async load(i: number): Promise<Texture> {
    // Reads via the Rust command (not the fs plugin) so it works regardless of webview fs scope; `invoke` resolves a raw byte response to an ArrayBuffer.
    const buffer = await invoke<ArrayBuffer>("read_clip_frame", { path: this.path(i) });
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
    this.cache.set(i, tex);
    this.loading.delete(i);
    this.touch(i);
    this.evict();
    return tex;
  }

  private touch(i: number): void {
    const at = this.order.indexOf(i);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(i);
  }

  private evict(): void {
    // Oldest-first, skipping pinned frames (a bound frame must never be closed under the renderer); if everything old is pinned we simply hold more than LRU_CAPACITY, bounded by the number of mounted consumers.
    let scan = 0;
    while (this.order.length > LRU_CAPACITY && scan < this.order.length) {
      const idx = this.order[scan];
      if (this.isPinned(idx)) {
        scan++;
        continue;
      }
      this.order.splice(scan, 1);
      disposeTexture(this.cache.get(idx));
      this.cache.delete(idx);
    }
  }

  /** Post-eviction cleanup: closes unpinned frames now; pinned ones stay alive for still-mounted consumers (closing a bound bitmap renders white) and fall to GC once they re-bind against the replacement entry. */
  retire(): void {
    this.order = this.order.filter((i) => {
      if (this.isPinned(i)) return true;
      disposeTexture(this.cache.get(i));
      this.cache.delete(i);
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

/** Resolves a project-relative clip `src` for the active project and subscribes the caller to its extraction: registers on-demand and forces a re-render when extraction resolves, so the primitive can read `entry.info`/`entry.frames` synchronously (including inside the export loop's `flushSync`). */
export function useClipEntry(src: string): ClipEntry {
  // Resolves against the project that owns this mounted scene (ProjectIdContext), not the live store: during a project switch the store's projectId flips one render before old scenes unmount, which used to resolve this clip against the wrong project's assets.
  const contextProjectId = useContext(ProjectIdContext);
  const storeProjectId = useEditorStore((s) => s.projectId);
  const srcAbs = resolveAssetPath(contextProjectId ?? storeProjectId, src);
  // Re-registers after an eviction (the invalidation sweep), picking up the fresh extraction.
  useSyncExternalStore(subscribeClipRegistry, clipRegistryVersion);
  const entry = registerClip(srcAbs);
  const [, force] = useState(0);
  useEffect(() => {
    if (entry.info || entry.error) return;
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
  }, [entry]);
  return entry;
}
