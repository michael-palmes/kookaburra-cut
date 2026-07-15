import { useCallback, useEffect, useMemo, useRef } from "react";
import { type Mesh, MeshBasicMaterial } from "three";
import { clipPlaneSize } from "../../engine/clipFrame";
import { useClipTexture } from "../../engine/clipTexture";
import { isExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import type { V3 } from "../types";
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
}

/** Embedded video clip: the ffmpeg sidecar pre-extracts the source to a CFR frame sequence, and frame selection is a pure function of the timeline (never `HTMLVideoElement` seeking) so preview and export pick the identical frame; the sampling/binding core lives in `engine/clipTexture.ts` (shared with the Device screen), and this primitive is the plane-mesh consumer, sized via `fit`. See docs/determinism.md. */
export function VideoClip(props: VideoClipProps) {
  const { src, startMs, fit = "contain", position = [0, 0, 0], scale = 1 } = props;
  const format = useFormat();
  const meshRef = useRef<Mesh>(null);

  // Own the material instance rather than relying on r3f's `<meshBasicMaterial>` attachment (whose ref/`mesh.material` proved unreliable across StrictMode remounts); writing the frame texture onto this exact object guarantees it lands on what's rendered.
  const material = useMemo(() => {
    const m = new MeshBasicMaterial();
    m.toneMapped = false;
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  // The mesh stays hidden until its first frame is uploaded.
  const onPending = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = false;
  }, []);
  const onBound = useCallback(() => {
    if (meshRef.current) meshRef.current.visible = true;
  }, []);

  const { info } = useClipTexture({
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
      {!info && !isExporting() && (
        <mesh position={position} scale={scale}>
          <planeGeometry args={[pendingSize.width, pendingSize.height]} />
          <meshBasicMaterial map={preparingVideoTexture(16 / 9, true)} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}
