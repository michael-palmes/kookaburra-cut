import { useEffect, useMemo } from "react";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { LightRig } from "../lighting/LightRig";
import { useSceneStaged } from "../stage/context";
import type { V3 } from "../types";
import { text3dFont } from "./fonts";

export interface ExtrudedTextProps {
  text: string;
  /** Reveal start, in ms (local scene time). */
  from?: number;
  /** Reveal end, in ms (local scene time). */
  to?: number;
  position?: V3;
  /** Base rotation in radians (the reveal tilt settles onto `rotation[0]`). */
  rotation?: V3;
  fontSize?: number;
  /** Extrusion depth in world units. Defaults to `fontSize * 0.25`. */
  depth?: number;
  /** Bevelled edges (on by default; bevels are what sell the extrusion under light). */
  bevel?: boolean;
  /** Theme colour token for the material. */
  tone?: "text" | "accent" | "muted";
  /** Bundle a self-contained light rig (DeviceMockup pattern). Turn off when the scene lights itself or stacks several lit primitives (rigs add up). */
  lit?: boolean;
}

/** Extruded 3D text: real depth + bevels via FontLoader/TextGeometry, unlike the flat troika SDF of `AnimatedHeadline`; geometry is a pure function of props + the bundled typeface (parsed synchronously from JSON, see `fonts.ts`), and the reveal (rise + tilt settle) is a pure function of `useTimeline()`, never the wall clock. It animates transforms only, no transparency, so mid-reveal frames never show internal faces. */
export function ExtrudedText(props: ExtrudedTextProps) {
  const {
    text,
    from = 0,
    to = 600,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    fontSize = 0.6,
    depth = fontSize * 0.25,
    bevel = true,
    tone = "text",
    lit,
  } = props;

  // Staged scenes light themselves; the bundled rig stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;

  const { localMs } = useTimeline();
  const theme = useTheme();
  const font = text3dFont(theme.typography.headline);

  const geometry = useMemo(() => {
    const geo = new TextGeometry(text, {
      font,
      size: fontSize,
      depth,
      curveSegments: 12,
      bevelEnabled: bevel,
      bevelThickness: fontSize * 0.02,
      bevelSize: fontSize * 0.015,
      bevelSegments: 3,
    });
    geo.center(); // anchor centre/middle like AnimatedHeadline (and centre the depth axis)
    return geo;
  }, [text, font, fontSize, depth, bevel]);
  // Dispose the previous geometry when props change it (r3f only disposes on unmount).
  useEffect(() => () => geometry.dispose(), [geometry]);

  const reveal = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  const eased = 1 - (1 - reveal) ** 3;
  const rise = (1 - eased) * -0.6 * fontSize;
  const tilt = (1 - eased) * -0.9;

  return (
    <group position={position} rotation={rotation}>
      {isLit && <LightRig />}
      <group position={[0, rise, 0]} rotation={[tilt, 0, 0]}>
        <mesh geometry={geometry}>
          <meshStandardMaterial color={theme.colors[tone]} roughness={0.35} metalness={0.2} />
        </mesh>
      </group>
    </group>
  );
}
