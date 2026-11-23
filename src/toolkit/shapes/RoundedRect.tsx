import { useContext, useLayoutEffect, useMemo } from "react";
import { Color, GLSL3, ShaderMaterial, Vector2 } from "three";
import { useFormat } from "../../engine/format";
import { useTheme } from "../../theme";
import { GroupAnimationContext } from "../group/context";
import type { V3 } from "../types";
import {
  FLUID_CLIP_VARYING,
  FLUID_SCREEN_ST,
  type FluidFill,
  fluidFillFunction,
  fluidFillUniforms,
  type ResolvedFluidFill,
  useResolvedFluidFill,
  writeFluidTime,
} from "./fluidFill";

export interface PillProps {
  /** World-unit width. */
  width: number;
  /** World-unit height. */
  height: number;
  /** Fill colour (a theme token hex); defaults to the theme accent. */
  color?: string;
  opacity?: number;
  /** How solid the fill is under the border, 0..1 (default 1): 0 with a `strokeWidth` leaves an outline. Flat fills only. */
  fillOpacity?: number;
  /** Border ring width in world units, drawn just inside the edge; 0 or absent draws none. */
  strokeWidth?: number;
  /** Border colour; defaults to the theme text colour. */
  strokeColor?: string;
  /** A fluid gradient fill sampled in screen space, so several shapes look through one gradient; `true` takes colours from the theme accent. Replaces `color`. */
  fill?: FluidFill | boolean;
  position?: V3;
  /** Radians. */
  rotation?: V3;
  scale?: number | V3;
  renderOrder?: number;
}

export interface RoundedRectProps extends PillProps {
  /** Corner radius in world units, capped at half the shorter side. */
  radius?: number;
}

interface RectUniforms {
  [name: string]: { value: unknown };
  uSize: { value: Vector2 };
  uRadius: { value: number };
  uColor: { value: Color };
  uOpacity: { value: number };
  uStrokeColor: { value: Color };
  uStrokeWidth: { value: number };
  uFillOpacity: { value: number };
}

const VERTEX = /* glsl */ `
uniform vec2 uSize;
varying vec2 vRectPos;
void main() {
  vRectPos = position.xy * uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Linear-space fill and ring, then the stock colour-space chunk so a token hex lands exactly on screen.
const FRAGMENT = /* glsl */ `
uniform vec2 uSize;
uniform float uRadius;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uStrokeColor;
uniform float uStrokeWidth;
uniform float uFillOpacity;
varying vec2 vRectPos;
void main() {
  vec2 q = abs(vRectPos) - 0.5 * uSize + uRadius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float aa = max(fwidth(d), 1e-6);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
  vec3 rgb = uColor;
  float ring = 0.0;
  if (uStrokeWidth > 0.0) {
    ring = smoothstep(-aa, aa, d + uStrokeWidth);
    rgb = mix(uColor, uStrokeColor, ring);
  }
  float fill = uFillOpacity < 1.0 ? mix(uFillOpacity, 1.0, ring) : 1.0;
  gl_FragColor = vec4(rgb, coverage * uOpacity * fill);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function rectMaterial(): { material: ShaderMaterial; uniforms: RectUniforms } {
  const uniforms: RectUniforms = {
    uSize: { value: new Vector2(1, 1) },
    uRadius: { value: 0 },
    uColor: { value: new Color(1, 1, 1) },
    uOpacity: { value: 1 },
    uStrokeColor: { value: new Color(1, 1, 1) },
    uStrokeWidth: { value: 0 },
    uFillOpacity: { value: 1 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  return { material, uniforms };
}

/** An unlit, antialiased rounded rectangle with an optional border ring; colour-exact like ImageCard, and size, radius and colours animate without rebuilding geometry. With `fill` it shows a fluid gradient instead of a flat colour. */
export function RoundedRect(props: RoundedRectProps) {
  return props.fill ? <FluidRoundedRect {...props} /> : <FlatRoundedRect {...props} />;
}

function FlatRoundedRect(props: RoundedRectProps) {
  const {
    width,
    height,
    radius = 0,
    color,
    opacity = 1,
    fillOpacity = 1,
    strokeWidth = 0,
    strokeColor,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = 1,
    renderOrder = 0,
  } = props;
  const theme = useTheme();
  const group = useContext(GroupAnimationContext);
  const { material, uniforms } = useMemo(rectMaterial, []);
  useLayoutEffect(() => () => material.dispose(), [material]);

  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const half = Math.min(w, h) / 2;
  uniforms.uSize.value.set(w, h);
  uniforms.uRadius.value = Math.min(Math.max(0, radius), half);
  uniforms.uColor.value.set(color ?? theme.colors.accent);
  uniforms.uOpacity.value = opacity * (group?.alpha ?? 1);
  uniforms.uStrokeWidth.value = Math.min(Math.max(0, strokeWidth), half);
  uniforms.uStrokeColor.value.set(strokeColor ?? theme.colors.text);
  uniforms.uFillOpacity.value = Math.min(1, Math.max(0, fillOpacity));

  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh
        material={material}
        renderOrder={renderOrder}
        scale={[w || 1, h || 1, 1]}
        visible={w > 0 && h > 0}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
    </group>
  );
}

const FLUID_VERTEX = /* glsl */ `
uniform vec2 uSize;
out vec2 vRectPos;
out vec3 ${FLUID_CLIP_VARYING};
void main() {
  vRectPos = position.xy * uSize;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${FLUID_CLIP_VARYING} = clip.xyw;
  gl_Position = clip;
}
`;

// The flat fragment's coverage and ring over the fluid colour, decoded to linear so three's output encode lands it like the flat fill.
const fluidFragment = (fill: ResolvedFluidFill) => /* glsl */ `
${fluidFillFunction(fill.def.fragment)}
uniform vec2 uSize;
uniform float uRadius;
uniform float uOpacity;
uniform vec3 uStrokeColor;
uniform float uStrokeWidth;
in vec2 vRectPos;
in vec3 ${FLUID_CLIP_VARYING};
out vec4 kkOut;
void main() {
  vec2 q = abs(vRectPos) - 0.5 * uSize + uRadius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float aa = max(fwidth(d), 1e-6);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
  vec4 fluid = clamp(kkFluid(${FLUID_SCREEN_ST}), 0.0, 1.0);
  vec3 rgb = kkSrgbToLinear(fluid.rgb);
  if (uStrokeWidth > 0.0) {
    rgb = mix(rgb, uStrokeColor, smoothstep(-aa, aa, d + uStrokeWidth));
  }
  kkOut = linearToOutputTexel(vec4(rgb, coverage * uOpacity * fluid.a));
}
`;

function fluidRectMaterial(fill: ResolvedFluidFill, format: { width: number; height: number }) {
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      ...fluidFillUniforms(fill, format),
      uSize: { value: new Vector2(1, 1) },
      uRadius: { value: 0 },
      uOpacity: { value: 1 },
      uStrokeColor: { value: new Color(1, 1, 1) },
      uStrokeWidth: { value: 0 },
    },
    vertexShader: FLUID_VERTEX,
    fragmentShader: fluidFragment(fill),
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  return material;
}

function FluidRoundedRect(props: RoundedRectProps) {
  const {
    width,
    height,
    radius = 0,
    opacity = 1,
    strokeWidth = 0,
    strokeColor,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = 1,
    renderOrder = 0,
  } = props;
  const theme = useTheme();
  const { width: frameW, height: frameH } = useFormat();
  const group = useContext(GroupAnimationContext);
  const fill = useResolvedFluidFill(props.fill, theme);
  const material = useMemo(
    () => (fill ? fluidRectMaterial(fill, { width: frameW, height: frameH }) : null),
    [fill, frameW, frameH],
  );
  useLayoutEffect(() => () => material?.dispose(), [material]);
  const speed = fill?.speed ?? 0;
  const beforeRender = useMemo(
    () => () => {
      if (material) writeFluidTime(material.uniforms, speed);
    },
    [material, speed],
  );
  if (!material) return null;

  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const half = Math.min(w, h) / 2;
  const u = material.uniforms;
  u.uSize.value.set(w, h);
  u.uRadius.value = Math.min(Math.max(0, radius), half);
  u.uOpacity.value = opacity * (group?.alpha ?? 1);
  u.uStrokeWidth.value = Math.min(Math.max(0, strokeWidth), half);
  u.uStrokeColor.value.set(strokeColor ?? theme.colors.text);

  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh
        material={material}
        renderOrder={renderOrder}
        scale={[w || 1, h || 1, 1]}
        visible={w > 0 && h > 0}
        onBeforeRender={beforeRender}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
    </group>
  );
}

/** A RoundedRect whose radius is half the shorter side. */
export function Pill(props: PillProps) {
  return <RoundedRect {...props} radius={Math.min(props.width, props.height) / 2} />;
}
