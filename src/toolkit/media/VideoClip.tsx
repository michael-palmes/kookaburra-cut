import { useCallback, useEffect, useMemo, useRef } from "react";
import { type Mesh, MeshBasicMaterial } from "three";
import { clipPlaneSize } from "../../engine/clipFrame";
import { useClipTexture } from "../../engine/clipTexture";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import type { V3 } from "../types";
import { applyCardMask, cardUniforms } from "./LayeredScreenshot";
import { preparingVideoTexture } from "./preparingTexture";

export interface VideoClipProps {
  /** Project-relative source path, e.g. `"assets/clip.mp4"`. Extracted to frames on demand. */
  src: string;
  /** When the clip starts, in ms (local scene time). */
  startMs: number;
  /** `contain` fits the whole clip in the frame (letterbox); `cover` fills + crops. */
  fit?: "cover" | "contain";
  position?: V3;
  scale?: number;
  /** Rounds the corners, as a fraction of the short edge (0 to 0.5), so a clip reads as a card. */
  radius?: number;
  /** 0..1 (default 1), so a card can fade as it rides a carousel. */
  opacity?: number;
}

/** A prop clamped to 0..1, the fallback when it is unset or not a number. */
function unit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Embedded video clip: the ffmpeg sidecar pre-extracts the source to a CFR frame sequence, and frame selection is a pure function of the timeline (never `HTMLVideoElement` seeking) so preview and export pick the identical frame; the sampling/binding core lives in `engine/clipTexture.ts` (shared with the Device screen), and this primitive is the plane-mesh consumer, sized via `fit`. See docs/determinism.md. */
export function VideoClip(props: VideoClipProps) {
  const { src, startMs, fit = "contain", position = [0, 0, 0], scale = 1 } = props;
  const format = useFormat();
  const meshRef = useRef<Mesh>(null);
  // Sticky once set, so a prop that comes and goes never rebuilds the material; never set keeps the opaque legacy plane exactly.
  const modeRef = useRef({ rounded: false, faded: false });
  modeRef.current.rounded ||= props.radius !== undefined;
  modeRef.current.faded ||= modeRef.current.rounded || props.opacity !== undefined;
  const { rounded, faded } = modeRef.current;
  const card = useMemo(() => (rounded ? cardUniforms() : null), [rounded]);

  // Own the material instance rather than relying on r3f's `<meshBasicMaterial>` attachment (whose ref/`mesh.material` proved unreliable across StrictMode remounts); writing the frame texture onto this exact object guarantees it lands on what's rendered.
  const material = useMemo(() => {
    const m = new MeshBasicMaterial();
    m.toneMapped = false;
    if (faded) {
      m.transparent = true;
      m.depthWrite = false;
    }
    if (card) applyCardMask(m, card);
    return m;
  }, [faded, card]);
  useEffect(() => () => material.dispose(), [material]);

  // The mesh stays hidden until its first frame is uploaded.
  const onPending = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = false;
  }, []);
  const onBound = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = true;
  }, []);

  const { info, ready } = useClipTexture({
    src,
    startMs,
    material,
    readyObjectRef: meshRef,
    onPending,
    onBound,
  });

  const planeSize = useMemo(
    () => (info ? clipPlaneSize(fit, format.frame, info) : { width: 0, height: 0 }),
    [fit, format.frame, info],
  );
  if (faded) material.opacity = unit(props.opacity, 1);
  if (card) {
    const short = Math.min(planeSize.width, planeSize.height);
    card.uCardSize.value.set(planeSize.width, planeSize.height);
    card.uCardRadius.value = Math.min(0.5, unit(props.radius, 0)) * short;
  }

  // While frames extract, a 16:9 stand-in plane shows the shared "Preparing video…" card instead of nothing, PREVIEW ONLY: `isExporting()` stands it down and the export barriers mean no captured frame can sample it anyway; the readiness ref stays on the real mesh.
  const pendingSize = useMemo(
    () =>
      clipPlaneSize(fit, format.frame, { width: 1920, height: 1080 } as Parameters<
        typeof clipPlaneSize
      >[2]),
    [fit, format.frame],
  );

  return (
    <>
      <mesh ref={meshRef} position={position} scale={scale}>
        <planeGeometry args={[planeSize.width, planeSize.height]} />
        <primitive object={material} attach="material" />
      </mesh>
      {!ready && !isExporting() && (
        <mesh position={position} scale={scale}>
          <planeGeometry args={[pendingSize.width, pendingSize.height]} />
          <meshBasicMaterial map={preparingVideoTexture(16 / 9, true)} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}
