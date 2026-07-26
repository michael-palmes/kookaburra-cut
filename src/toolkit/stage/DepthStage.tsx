import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { useDepthStageRegistry } from "../../engine/depthStageRegistry";
import { useFormat } from "../../engine/format";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import {
  envelopeOverscan,
  normalizeSceneRig,
  type RigEnvelope,
  rigEnvelope,
} from "../../engine/sceneRig";

/** Named depth bands for a scene a camera rig flies THROUGH: content where scenes already lay out, a foreground layer between the camera and it, and two layers behind. Every band sizes its full-bleed rect from the scene's rig envelope, so a layer that fills the frame at rest still fills it at the far end of a fly-through. A scene with no rig gets today's static sizing, which is why adding the container to an existing scene changes nothing. Band depths are EXPORT CONTRACT; see docs/determinism.md. */

/** World z of each band. Foreground sits between the base camera (z 5) and the content plane; the two rear bands spread far enough apart to read as parallax without leaving the cyclorama (wall at z -6). */
export const DEPTH_BANDS = {
  foreground: 1.8,
  content: 0,
  midground: -2.4,
  backdrop: -5.5,
} as const;

export type DepthBandName = keyof typeof DEPTH_BANDS;

/** What a band offers its children: its depth and the world rect that covers the frame there for the whole of the scene's camera travel. */
export interface DepthBand {
  name: DepthBandName;
  z: number;
  width: number;
  height: number;
}

const DepthBandContext = createContext<DepthBand | null>(null);

/** The band a component is mounted in, or null outside a DepthStage (mount-anywhere, the SceneStage precedent). */
export function useDepthBand(): DepthBand | null {
  return useContext(DepthBandContext);
}

/** The scene's camera travel, or null when it has no rig. Derived from the scene doc already in context, so preview and export resolve it identically by construction rather than by a plumbing rule. */
export function useRigEnvelope(): RigEnvelope | null {
  const doc = useContext(SceneDocContext);
  return useMemo(() => {
    if (doc?.cameraMode !== "rig") return null;
    const track = normalizeSceneRig(doc.cameraRig, "rig-envelope", doc);
    return track ? rigEnvelope(track) : null;
  }, [doc]);
}

export function DepthStage({
  foreground,
  content,
  midground,
  backdrop,
}: {
  foreground?: ReactNode;
  content?: ReactNode;
  midground?: ReactNode;
  backdrop?: ReactNode;
}) {
  const format = useFormat();
  const envelope = useRigEnvelope();
  // Mount-time reporting, so the bounds advisory knows this scene sizes its own layers.
  const sceneIndex = useSceneContext()?.index;
  useEffect(() => {
    if (sceneIndex === undefined) return;
    useDepthStageRegistry.getState().register(sceneIndex);
    return () => useDepthStageRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  const bands = useMemo(() => {
    const build = (name: DepthBandName): DepthBand => {
      const z = DEPTH_BANDS[name];
      // No rig: the band covers exactly what the base camera sees there, today's assumption.
      const scale = envelope ? envelopeOverscan(envelope, format.frame, z) : 1;
      return {
        name,
        z,
        width: format.frame.width * scale,
        height: format.frame.height * scale,
      };
    };
    return {
      foreground: build("foreground"),
      content: build("content"),
      midground: build("midground"),
      backdrop: build("backdrop"),
    };
  }, [envelope, format.frame]);

  // Rear to front, so a band's children draw over the ones behind them without depth tricks.
  return (
    <group>
      <Band band={bands.backdrop}>{backdrop}</Band>
      <Band band={bands.midground}>{midground}</Band>
      <Band band={bands.content}>{content}</Band>
      <Band band={bands.foreground}>{foreground}</Band>
    </group>
  );
}

function Band({ band, children }: { band: DepthBand; children?: ReactNode }) {
  if (!children) return null;
  return (
    <DepthBandContext.Provider value={band}>
      <group position={[0, 0, band.z]}>{children}</group>
    </DepthBandContext.Provider>
  );
}
