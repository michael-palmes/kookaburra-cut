import { useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { MeshBasicMaterial, Object3D, Texture } from "three";
import { clipFrameIndex } from "./clipFrame";
import { type ClipInfo, type ClipTier, useClipEntry } from "./clips";
import { isExporting } from "./exportState";
import { perfClipsFrozen } from "./perfProbe";
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
  /** Extraction result (undefined until the sidecar extraction resolves). */
  info: ClipInfo | undefined;
  /** Extraction failure, if any (the consumer decides how to degrade). */
  error: string | undefined;
  /** The clock-mapped frame index for the current committed timeline value. */
  frameIndex: number;
}

function isDetached(tex: Texture): boolean {
  const img = tex.image as ImageBitmap | undefined;
  return !!img && img.width === 0;
}

/** How far outside its own window a scene still advances frames; covers transition overlaps and gives the next scene's first frame a head start. */
const ACTIVE_LEAD_MS = 500;

export function useClipTexture(binding: ClipTextureBinding): ClipTextureState {
  const { src, startMs, loop, material, readyObjectRef, onPending, onBound } = binding;
  const { localMs } = useTimeline();
  const sceneCtx = useSceneContext();
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const { info, frames, error } = useClipEntry(src);

  // Scenes away from the playhead hold their last frame instead of decoding: off-screen decode was the measured playback bottleneck (perf probe 2026-07-18). Export-safe by construction: the exporter only captures scenes whose window contains the clock, and those always advance. The perf probe's frozen-media pass holds every consumer the same way. No scene context (persistent layer) = always advance.
  const near =
    !sceneCtx || (localMs >= -ACTIVE_LEAD_MS && localMs <= sceneCtx.durationMs + ACTIVE_LEAD_MS);
  const heldFrameRef = useRef(0);
  if (info && near && !perfClipsFrozen()) {
    const raw = clipFrameIndex(localMs, startMs, info.fps, info.frameCount, loop === true);
    // Balanced/Performance thin preview media to every strideth frame; exports always bind exact frames.
    const stride = isExporting() ? 1 : previewClipStride();
    heldFrameRef.current = stride > 1 ? raw - (raw % stride) : raw;
  }
  const frameIndex = heldFrameRef.current;
  // Playback binds the small preview JPEGs once generated; pausing rebinds the exact full PNG immediately (the subscription re-renders this consumer), and exports never leave the full tier.
  const playing = useSyncExternalStore(subscribePreviewPlayback, previewPlaybackActive);
  const tier: ClipTier = playing && !isExporting() && frames?.hasPreviews() ? "preview" : "full";

  // Binds the committed frame's texture to the owned material and publishes an export-readiness promise; runs inside the export loop's flushSync so `awaitVideoFramesReady` sees a promise for the correct frame, and the promise never rejects since a single failed frame must not abort an export.
  useLayoutEffect(() => {
    const target = readyObjectRef.current;
    if (!target) return;
    if (!frames) {
      onPending?.();
      target.userData.videoFrameReady = () => Promise.resolve();
      return;
    }
    let cancelled = false;
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
      })
      .catch((err) => {
        if (!cancelled) console.error(`useClipTexture: frame ${frameIndex} failed to load`, err);
      });
    target.userData.videoFrameReady = () => ready;
    return () => {
      cancelled = true;
    };
  }, [frames, frameIndex, tier, material, invalidate, gl, readyObjectRef, onPending, onBound]);

  // Release this consumer's pin when it unmounts (or the source's ClipFrames changes).
  useEffect(() => {
    if (!frames) return;
    return () => frames.unpin(material);
  }, [frames, material]);

  return { info, error, frameIndex };
}
