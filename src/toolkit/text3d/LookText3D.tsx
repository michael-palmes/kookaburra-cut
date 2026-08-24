import { type RefObject, useContext, useEffect, useMemo } from "react";
import { type Mesh, MeshPhysicalMaterial, MeshStandardMaterial, type Object3D } from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { useHeldLocalMs } from "../../engine/presentHold";
import { useTimeline } from "../../engine/timeline";
import type { FontRef, Theme } from "../../theme/tokens";
import { GroupAnimationContext } from "../group/context";
import type { ResolvedTextLook } from "../text/looks";
import { type ResolvedTextAnimation, sampleTextUnit } from "../text/presets";
import type { V3 } from "../types";
import { text3dFont } from "./fonts";
import {
  anchorShift,
  chromeMaterialParams,
  glassMaterialParams,
  LOOK3D_DEPTH_EM,
} from "./lookLayout";

export interface LookText3DProps {
  text: string;
  look: ResolvedTextLook;
  theme: Theme;
  /** The resolved motion, degraded to whole-block transforms from the unit-0 sample; null runs the v0 linear ramp on material opacity. */
  anim: ResolvedTextAnimation | null;
  from?: number;
  to?: number;
  outAt?: number;
  position?: V3;
  fontSize?: number;
  fontRef?: FontRef;
  face?: "headline" | "body";
  anchorX?: "left" | "center" | "right";
  anchorY?: "top" | "middle" | "bottom";
  /** Sidecar tilt in radians (already resolved by the dispatcher; 0 means none). */
  rotZ: number;
  meshRef: RefObject<Object3D | null>;
}

/** The 3D look twin: `AnimatedHeadline` re-rendered as extruded geometry (glass-3d / chrome-3d) with the same string, size, anchor mapping and world placement. Scene lighting and the environment light it (no bundled rig); motion presets degrade to whole-block transforms from the unit-0 sample (alpha drives material opacity, transparent only while fading; a mask sweep degrades to its covered fraction as opacity; SDF-only fields are ignored), all pure functions of the scene clock. */
export function LookText3D(props: LookText3DProps) {
  const {
    text,
    look,
    theme,
    anim,
    from = 0,
    to = 600,
    outAt,
    position = [0, 0, 0],
    fontSize = 0.6,
    rotZ,
    meshRef,
  } = props;
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const anchorX = props.anchorX ?? "center";
  const anchorY = props.anchorY ?? "middle";
  const font = text3dFont(props.fontRef ?? theme.typography[props.face ?? "headline"]);

  const geometry = useMemo(() => {
    const geo = new TextGeometry(text, {
      font,
      size: fontSize,
      depth: fontSize * LOOK3D_DEPTH_EM,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: fontSize * 0.02,
      bevelSize: fontSize * 0.015,
      bevelSegments: 3,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (bb) {
      const shift = anchorShift(
        [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z],
        anchorX,
        anchorY,
      );
      geo.translate(shift[0], shift[1], shift[2]);
    }
    return geo;
  }, [text, font, fontSize, anchorX, anchorY]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // glass defaults to clear (an accent default would dye every glass headline); chrome takes the contract's accent fallback as its tint.
  const tint = look.colorA ?? (look.preset === "glass-3d" ? "#ffffff" : theme.colors.accent);
  const glass = look.preset === "glass-3d";
  const intensity = look.intensity;
  const material = useMemo(
    () =>
      glass
        ? new MeshPhysicalMaterial(glassMaterialParams(intensity, fontSize, tint))
        : new MeshStandardMaterial(chromeMaterialParams(tint)),
    [glass, intensity, fontSize, tint],
  );
  useEffect(() => () => material.dispose(), [material]);

  const groupAlpha = group?.alpha ?? 1;
  let alpha: number;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let scale = 1;
  let scaleX = 1;
  let scaleY = 1;
  let rotX = 0;
  let rotY = 0;
  let rotZSample = 0;
  if (anim) {
    const sample = sampleTextUnit({ anim, from, to, outAt }, 0, localMs, { count: 1 });
    const sweepCover = Math.max(0, Math.min(1, sample.sweep[1] - sample.sweep[0]));
    alpha = sample.alpha * groupAlpha * sweepCover;
    dx = sample.dxEm * fontSize;
    dy = sample.dyEm * fontSize;
    dz = sample.dzEm * fontSize;
    scale = sample.scale;
    scaleX = sample.scaleX;
    scaleY = sample.scaleY;
    rotX = sample.rotXRad;
    rotY = sample.rotYRad;
    rotZSample = sample.rotZRad;
  } else {
    const reveal = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
    alpha = reveal * groupAlpha;
  }
  material.opacity = alpha;
  material.transparent = alpha < 1;

  return (
    <group
      position={[position[0] + dx, position[1] + dy, position[2] + dz]}
      rotation={[rotX, rotY, rotZSample + rotZ]}
      scale={[scale * scaleX, scale * scaleY, scale]}
      visible={alpha > 0}
    >
      <mesh ref={meshRef as RefObject<Mesh>} geometry={geometry} material={material} />
    </group>
  );
}
