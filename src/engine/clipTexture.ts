import { useThree } from "@react-three/fiber";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MeshBasicMaterial, Object3D, Texture } from "three";
import { CLIP_ACTIVE_LEAD_MS } from "./clipChunks";
import { clipFrameIndex } from "./clipFrame";
import {
  ClipChunkError,
  type ClipDemand,
  type ClipInfo,
  ClipLoadSuperseded,
  type ClipTier,
  createFirstBind,
  type FirstBind,
  pendingFrameReady,
  publishClipConsumer,
  useClipEntry,
} from "./clips";
import { isExporting } from "./exportState";
import { noteClipBound, perfClipsFrozen } from "./perfProbe";
import { previewClipStride, previewPlaybackActive, subscribePreviewPlayback } from "./previewMedia";
import { useSceneContext } from "./sceneContext";
import { useTimeline } from "./timeline";

/** Shared clip-texture binding, the frame-sampling core extracted from `VideoClip` so any consumer can drive a material from the deterministic pre-extracted frame pipeline and publish `userData.videoFrameReady` for the export loop's `awaitVideoFramesReady` barrier. See docs/determinism.md. The bound frame is pinned in the shared ClipFrames LRU (unpinned on unmount) since an evicted frame's closed ImageBitmap throws WebGL INVALID_VALUE if uploaded; consumers must not mutate the bound texture, it's shared. */
export interface ClipTextureBinding {
  /** Project-relative source path, e.g. `"assets/clip.mp4"`. Extracted to frames on demand. */
  src: string;
  /** When the clip starts, in ms (local scene time). */
  startMs: number;
  /** Video background fills: wraps the frame index instead of holding the last frame; absent keeps the frozen clamp semantics (VideoClip/Device untouched). */
  loop?: boolean;
  /** Device screens with source-timing keys: picks the frame itself, replacing the `startMs`/`loop` mapping; absent keeps `clipFrameIndex`. */
  frameAt?: (localMs: number, info: ClipInfo) => number;
  /** Caller-owned material the current frame is written onto (`material.map`). */
  material: MeshBasicMaterial;
  /** Object that carries `userData.videoFrameReady`, reached by the export loop's scene traversal; must be a node rendered by the calling component's own subtree, since a parent's ref is still null during the mount commit (the divergent-verify root cause). */
  readyObjectRef: RefObject<Object3D | null>;
  /** Called in the layout effect while no frames exist yet (e.g. hide the mesh). */
  onPending?: () => void;
  /** Called after each successful frame bind (idempotent, e.g. unhide the mesh). */
  onBound?: () => void;
}

export interface ClipTextureState {
  /** Extraction result (undefined until the sidecar knows the clip's frame count). */
  info: ClipInfo | undefined;
  /** Extraction failure, if any (the consumer decides how to degrade). */
  error: string | undefined;
  /** The clock-mapped frame index for the current committed timeline value. */
  frameIndex: number;
  /** True once a first frame has bound, so a preview placeholder can give way (frames may still be extracting after `info` arrives). */
  ready: boolean;
}

function isDetached(tex: Texture): boolean {
  const img = tex.image as ImageBitmap | undefined;
  return !!img && img.width === 0;
}

/** Settles a consumer's first-bind wait and drops it, unless a newer wait has replaced it. */
function releaseFirstBind(ref: RefObject<FirstBind | null>, firstBind: FirstBind): void {
  firstBind.settle();
  if (ref.current === firstBind) ref.current = null;
}

export function useClipTexture(binding: ClipTextureBinding): ClipTextureState {
  const { src, startMs, loop, frameAt, material, readyObjectRef, onPending, onBound } = binding;
  // Screen media holds the frame instant's clip frame across a motion blur shutter.
  const { localMs } = useTimeline(0);
  const sceneCtx = useSceneContext();
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const entry = useClipEntry(src);
  const { info, frames, error, promise } = entry;
  const firstBindRef = useRef<FirstBind | null>(null);
  const [hasBound, setHasBound] = useState(false);
  const boundOnceRef = useRef(false);

  const mapFrame = (ms: number, clip: ClipInfo) =>
    frameAt
      ? frameAt(ms, clip)
      : clipFrameIndex(ms, startMs, clip.fps, clip.frameCount, loop === true);

  // Scenes away from the playhead hold their last frame instead of decoding: off-screen decode was the measured playback bottleneck (perf probe 2026-07-18). Export-safe by construction: the exporter only captures scenes whose window contains the clock, and those always advance. The perf probe's frozen-media pass holds every consumer the same way. No scene context (persistent layer) = always advance.
  const near =
    !sceneCtx ||
    (localMs >= -CLIP_ACTIVE_LEAD_MS && localMs <= sceneCtx.durationMs + CLIP_ACTIVE_LEAD_MS);
  const heldFrameRef = useRef(0);
  if (info && near && !perfClipsFrozen()) {
    const raw = mapFrame(localMs, info);
    // Balanced/Performance thin preview media to every strideth frame; exports always bind exact frames.
    const stride = isExporting() ? 1 : previewClipStride();
    heldFrameRef.current = stride > 1 ? raw - (raw % stride) : raw;
  }
  const frameIndex = heldFrameRef.current;
  // Playback binds the small preview JPEGs once its chunk has them; pausing rebinds the exact full PNG immediately (the subscription re-renders this consumer), and exports never leave the full tier.
  const playing = useSyncExternalStore(subscribePreviewPlayback, previewPlaybackActive);
  const previewing = playing && !isExporting() && frames !== undefined;
  const tier: ClipTier = previewing && frames.hasPreviews(frameIndex) ? "preview" : "full";
  // Read by the bind effect without re-running it: only the frame, tier and source decide a bind.
  const bindContext = useRef({ key: entry.key, previewing });
  bindContext.current = { key: entry.key, previewing };

  // The export barrier reads every mounted consumer's frame window (and held frame) to extract exactly the chunks it binds; read lazily, so it is always this render's mapping.
  const demandRef = useRef<ClipDemand | null>(null);
  demandRef.current = {
    window: sceneCtx ? [-CLIP_ACTIVE_LEAD_MS, sceneCtx.durationMs + CLIP_ACTIVE_LEAD_MS] : null,
    frameAt: mapFrame,
    sceneStartMs: sceneCtx?.startMs ?? 0,
  };
  useLayoutEffect(
    () =>
      publishClipConsumer(entry, material, () => ({
        ...(demandRef.current as ClipDemand),
        heldFrame: heldFrameRef.current,
      })),
    [entry, material],
  );

  // Binds the committed frame's texture to the owned material and publishes an export-readiness promise; runs inside the export loop's flushSync so `awaitVideoFramesReady` sees a promise for the correct frame. A frame whose chunk is not on disk yet extracts first while the previous bound frame stays up. The promise never rejects for a single failed frame, except a chunk that cannot be extracted during an export: that fails the run rather than capturing black.
  useLayoutEffect(() => {
    const target = readyObjectRef.current;
    if (!target) return;
    target.userData.clipMaterial = material;
    if (!frames) {
      onPending?.();
      firstBindRef.current ??= createFirstBind(promise);
      const firstBind = firstBindRef.current;
      firstBind.extraction = promise;
      target.userData.videoFrameReady = () => pendingFrameReady(firstBind, src);
      // A failed extraction never binds, so the screen degrades to its pending black.
      if (error !== undefined) releaseFirstBind(firstBindRef, firstBind);
      return;
    }
    let cancelled = false;
    const firstBind = firstBindRef.current;
    firstBind?.start();
    // Pins the requested index synchronously before the async load: a post-resolve pin would leave a microtask gap where another consumer's load could evict+close this frame, a silently-stale capture (the divergent-verify bug).
    frames.request(material, frameIndex, tier);
    const ready = frames
      .get(frameIndex, tier)
      .then(async (tex) => {
        // Defence in depth: request-time pinning should make detachment impossible, but a capture must never silently hold the previous frame, so retry loudly then scream.
        let bindable = tex;
        for (let attempt = 0; isDetached(bindable) && attempt < 3 && !cancelled; attempt++) {
          console.error(`useClipTexture: frame ${frameIndex} detached before bind — reloading`);
          bindable = await frames.get(frameIndex, tier);
        }
        if (cancelled) return;
        if (isDetached(bindable)) {
          console.error(`useClipTexture: frame ${frameIndex} STILL detached — stale capture`);
          return;
        }
        frames.markBound(material, frameIndex, tier);
        if (material.map !== bindable) {
          material.map = bindable;
          material.needsUpdate = true;
        }
        // Uploads to the GPU now while the bitmap is provably alive: textures otherwise upload lazily on first draw, which for a not-yet-visible scene can be thousands of ms later, and a bitmap closed in between uploads as an incomplete texture that samples black (the divergent-verify bug). With the GPU copy made eagerly, the bitmap's later fate cannot affect pixels.
        gl.initTexture(bindable);
        onBound?.();
        invalidate();
        if (!boundOnceRef.current) {
          boundOnceRef.current = true;
          noteClipBound(bindContext.current.key);
          // No re-render mid-export: the ref carries it until the next ordinary render.
          if (!isExporting()) setHasBound(true);
        }
        // Playback's lighter tier for this chunk generates in the background once its PNGs exist.
        if (bindContext.current.previewing && tier === "full") frames.requestPreviews(frameIndex);
      })
      .catch((err) => {
        if (cancelled || err instanceof ClipLoadSuperseded) return;
        if (err instanceof ClipChunkError && isExporting()) throw err;
        console.error(`useClipTexture: frame ${frameIndex} failed to load`, err);
      });
    // Rejections reach the export barrier through `videoFrameReady`; nothing else awaits them.
    ready.catch(() => {});
    target.userData.videoFrameReady = () => ready;
    // Only a run that finished releases a waiting capture: a cancelled one resolves `ready` without binding.
    if (firstBind) {
      void ready.then(
        () => {
          if (!cancelled) releaseFirstBind(firstBindRef, firstBind);
        },
        () => releaseFirstBind(firstBindRef, firstBind),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [
    frames,
    frameIndex,
    tier,
    material,
    invalidate,
    gl,
    readyObjectRef,
    onPending,
    onBound,
    promise,
    error,
    src,
  ]);

  // A consumer unmounting before its first bind releases any capture waiting on it.
  useLayoutEffect(
    () => () => {
      if (firstBindRef.current) releaseFirstBind(firstBindRef, firstBindRef.current);
    },
    [],
  );

  // Release this consumer's pin when it unmounts (or the source's ClipFrames changes).
  useEffect(() => {
    if (!frames) return;
    return () => frames.unpin(material);
  }, [frames, material]);

  return { info, error, frameIndex, ready: hasBound || boundOnceRef.current };
}
