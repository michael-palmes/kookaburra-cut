import { useContext, useEffect, useId, useLayoutEffect, useMemo } from "react";
import { ExtrudeGeometry } from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { shouldRenderManagedTextRole } from "../../engine/managedText";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import {
  resolveTokenFill,
  textStyleOffsetPosition,
  textStyleRotationRad,
  textStyleValue,
} from "../../engine/textStyleResolve";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { LightRig } from "../lighting/LightRig";
import { useSceneStaged } from "../stage/context";
import type { V3 } from "../types";
import { smoothExtrudeNormals } from "./extrudeNormals";
import { text3dFont } from "./fonts";
import { roundShapes } from "./roundCorners";

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
  /** Bevelled edges (on by default; bevels are what sell the extrusion under light). An object rounds them: `size` and `thickness` in em (0.015 and 0.02 by default), `segments` (3), and `corner`, an em radius that also rounds each glyph's own sharp corners. */
  bevel?: boolean | ExtrudedBevel;
  /** The surface. Absent keeps the satin default; any field switches to a clearcoated finish whose gloss shows under area lights and the environment. */
  finish?: ExtrudedFinish;
  /** Cast and take the stage's shadows. */
  shadow?: boolean;
  /** `"bottom"` stands the text on its position (its lowest point at y 0) instead of centring it. */
  anchorY?: "middle" | "bottom";
  /** Theme colour token for the material. */
  tone?: "text" | "accent" | "muted";
  /** Bundle a self-contained light rig (DeviceMockup pattern). Turn off when the scene lights itself or stacks several lit primitives (rigs add up). */
  lit?: boolean;
  /** The sidecar style key this text honours: registers the row in the Edit-text drill and applies the `textStyle.<textKey>*` overrides (Size/Color/OffsetX/OffsetY/RotationDeg). */
  textKey?: string;
}

export interface ExtrudedBevel {
  size?: number;
  thickness?: number;
  segments?: number;
  corner?: number;
}

export interface ExtrudedFinish {
  roughness?: number;
  metalness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
}

/** Extruded 3D text: real depth + bevels via FontLoader/TextGeometry, unlike the flat troika SDF of `AnimatedHeadline`; geometry is a pure function of props + the bundled typeface (parsed synchronously from JSON, see `fonts.ts`), and the reveal (rise + tilt settle) is a pure function of `useTimeline()`, never the wall clock. It animates transforms only, no transparency, so mid-reveal frames never show internal faces. With a `textKey` it joins the managed-text lifecycle, so it stands down under a generic takeover like every scene-owned text primitive. */
export function ExtrudedText(props: ExtrudedTextProps) {
  const doc = useContext(SceneDocContext);
  if (props.textKey && !shouldRenderManagedTextRole(doc, "scene")) return null;
  return <ExtrudedTextRenderer {...props} />;
}

function ExtrudedTextRenderer(props: ExtrudedTextProps) {
  const {
    text,
    from = 0,
    to = 600,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    fontSize = 0.6,
    bevel = true,
    tone = "text",
    lit,
    textKey,
    finish,
    shadow = false,
    anchorY = "middle",
  } = props;
  const round = typeof bevel === "object" ? bevel : null;
  const rounded = round !== null;
  const bevelled = bevel !== false;
  const bevelSize = round?.size ?? 0.015;
  const bevelThickness = round?.thickness ?? 0.02;
  const bevelSegments = round?.segments ?? 3;
  const corner = round?.corner ?? 0;

  // Staged scenes light themselves; the bundled rig stands down by default.
  const staged = useSceneStaged();
  const isLit = lit ?? !staged;

  const { localMs } = useTimeline();
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const font = text3dFont(theme.typography.headline);

  // Sidecar overrides read through the shared resolvers; the depth default follows the SCALED size so the extrusion keeps its proportions.
  const sizeMul = textStyleValue(doc, textKey, "Size");
  const size = typeof sizeMul === "number" ? fontSize * sizeMul : fontSize;
  const depth = props.depth ?? size * 0.25;
  const colourValue = textStyleValue(doc, textKey, "Color");
  const fill = resolveTokenFill(theme, typeof colourValue === "string" ? colourValue : tone);
  const pos = textStyleOffsetPosition(doc, textKey, position);
  const rotZ = textStyleRotationRad(doc, textKey);
  const groupRotation =
    rotZ === 0 ? rotation : ([rotation[0], rotation[1], rotation[2] + rotZ] as V3);

  // Report the editable field to the registry so the Edit-text drill-in offers it (Font stays off: the 3D face is the bundled typeface).
  const sceneIndex = useSceneContext()?.index;
  const mountId = useId();
  const registeredColor = typeof colourValue === "string" ? colourValue : tone;
  const offX = textStyleValue(doc, textKey, "OffsetX");
  const offY = textStyleValue(doc, textKey, "OffsetY");
  const rotDeg = textStyleValue(doc, textKey, "RotationDeg");
  useLayoutEffect(() => {
    if (sceneIndex === undefined || !textKey || doc?.managedText !== undefined) return;
    useTextKeyRegistry.getState().register(sceneIndex, textKey, mountId, {
      colorDefault: tone,
      styleCapable: true,
      resolvedText: text,
      // The bundled 3D typeface ignores Font, and single-line geometry ignores LineHeight.
      inertStyleControls: ["font", "spacing"],
      style: {
        color: registeredColor,
        size: typeof sizeMul === "number" ? sizeMul : 1,
        offsetX: typeof offX === "number" ? offX : 0,
        offsetY: typeof offY === "number" ? offY : 0,
        rotationDeg: typeof rotDeg === "number" ? rotDeg : 0,
      },
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey, mountId);
  }, [
    sceneIndex,
    textKey,
    mountId,
    doc?.managedText,
    text,
    tone,
    registeredColor,
    sizeMul,
    offX,
    offY,
    rotDeg,
  ]);

  const geometry = useMemo(() => {
    const options = {
      depth,
      curveSegments: bevelSegments > 3 ? 24 : 12,
      bevelEnabled: bevelled,
      bevelThickness: size * bevelThickness,
      bevelSize: size * bevelSize,
      bevelSegments,
    };
    const flat =
      corner > 0
        ? new ExtrudeGeometry(
            roundShapes(font.generateShapes(text, size), size * corner, options.curveSegments),
            options,
          )
        : new TextGeometry(text, { font, size, ...options });
    const geo = rounded && bevelSize > 0 && bevelThickness > 0 ? smoothExtrudeNormals(flat) : flat;
    if (geo !== flat) flat.dispose();
    geo.center(); // anchor centre/middle like AnimatedHeadline (and centre the depth axis)
    if (anchorY === "bottom" && geo.boundingBox) geo.translate(0, -geo.boundingBox.min.y, 0);
    return geo;
  }, [
    text,
    font,
    size,
    depth,
    bevelled,
    rounded,
    bevelSize,
    bevelThickness,
    bevelSegments,
    corner,
    anchorY,
  ]);
  // Dispose the previous geometry when props change it (r3f only disposes on unmount).
  useEffect(() => () => geometry.dispose(), [geometry]);

  const reveal = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  const eased = 1 - (1 - reveal) ** 3;
  const rise = (1 - eased) * -0.6 * size;
  const tilt = (1 - eased) * -0.9;

  return (
    <group position={pos} rotation={groupRotation}>
      {isLit && <LightRig />}
      <group position={[0, rise, 0]} rotation={[tilt, 0, 0]}>
        <mesh geometry={geometry} castShadow={shadow} receiveShadow={shadow}>
          {finish ? (
            <meshPhysicalMaterial
              color={fill}
              roughness={finish.roughness ?? 0.35}
              metalness={finish.metalness ?? 0.2}
              clearcoat={finish.clearcoat ?? 1}
              clearcoatRoughness={finish.clearcoatRoughness ?? 0.1}
            />
          ) : (
            <meshStandardMaterial color={fill} roughness={0.35} metalness={0.2} />
          )}
        </mesh>
      </group>
    </group>
  );
}
