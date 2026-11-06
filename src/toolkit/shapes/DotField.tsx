import { useContext, useLayoutEffect, useMemo } from "react";
import {
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  ShaderMaterial,
  Vector2,
} from "three";
import { useFormat } from "../../engine/format";
import { useTheme } from "../../theme";
import type { Theme } from "../../theme/tokens";
import { GroupAnimationContext } from "../group/context";
import type { V3 } from "../types";
import {
  type DotAdjust,
  type DotCount,
  type DotCountRun,
  type DotFieldFrame,
  type DotFunnel,
  type DotGather,
  type DotInfo,
  type DotReveal,
  type DotWave,
  type DotWindow,
  dotFieldFrame,
  dotGrid,
} from "./dotFieldMath";
import {
  FLUID_CLIP_VARYING,
  FLUID_SCREEN_ST,
  type FluidFill,
  fluidFillFunction,
  fluidFillUniforms,
  type ResolvedFluidFill,
  themeColourHex,
  useResolvedFluidFill,
  writeFluidTime,
} from "./fluidFill";

export interface DotFieldProps {
  /** Dots across (default 10). */
  columns?: number;
  /** Dots down (default 10). */
  rows?: number;
  /** Centre-to-centre spacing in world units, or [across, down] (default 0.3). */
  pitch?: number | readonly [number, number];
  /** Dot diameter as a fraction of the pitch (default 0.72). */
  size?: number;
  /** "circle" (default) or "square", a waffle cell. */
  shape?: "circle" | "square";
  /** A square's corner radius, 0..1 of half its side (default 0.25). */
  roundness?: number;
  /** Theme token (`text`, `muted`, `accent`, `background`) or hex (default `text`). */
  color?: string;
  /** A fluid gradient instead of the flat colour, sampled in screen space so the dots and any filled `RoundedRect` share one gradient; `true` takes colours from the theme accent. */
  fill?: FluidFill | boolean;
  opacity?: number;
  /** Dots pop in one by one. */
  reveal?: DotReveal;
  /** A travelling wave of dot sizes. */
  wave?: DotWave;
  /** A clearing that opens for a hero number. */
  window?: DotWindow;
  /** Dots recoloured in order as a value rolls: one run, or several stacked. */
  count?: DotCount | readonly DotCount[];
  /** Columns narrowing into an arrow. */
  funnel?: DotFunnel;
  /** Every dot drawn into one. */
  gather?: DotGather;
  /** 0..1: the dots swell and merge into one solid tile covering the grid (displaced dots return home first). */
  merge?: number;
  /** The merged tile's corner radius, world units (default half the pitch). */
  tileRadius?: number;
  /** Per-dot adjustment, called for every dot every frame: keep it a pure function of its argument and the clock. */
  dot?: (info: DotInfo) => DotAdjust | undefined;
  position?: V3;
  /** Radians. */
  rotation?: V3;
  scale?: number;
  renderOrder?: number;
}

const QUAD_POSITIONS = [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0];
const QUAD_INDEX = [0, 1, 2, 2, 1, 3];
/** AA room around each dot's quad: pixels at the content plane, plus a sliver of the pitch. */
const MARGIN_PX = 3;
const MARGIN_PITCH = 0.02;
const DEFAULT_SIZE = 0.72;
const DEFAULT_PITCH = 0.3;
const DEFAULT_ROUNDNESS = 0.25;

// Free dots draw a quad round each dot; merging dots that are home draw their exact cells (corners from whole and half cell edges, so neighbours share bit-identical edges and the tile has no seams), the grid's outer edges padded for AA. A dot still on its way home keeps a free quad, big enough for its swelling shape.
const VERTEX = /* glsl */ `
in vec2 aIndex;
in vec4 aDot;
in vec4 aTint;
uniform vec2 uGrid;
uniform vec2 uPitch;
uniform float uMerge;
uniform float uMargin;
uniform float uFramePixels;
out vec2 vLocal;
out vec4 vDot;
out vec4 vTint;
#ifdef KK_FLUID
out vec3 ${FLUID_CLIP_VARYING};
#endif
void main() {
  vec2 corner = position.xy;
  // AA room: a few export pixels at the field's own depth and scale (one value for every dot, so outer cell edges stay shared), plus a sliver of the pitch.
  vec4 origin = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float pixel = 2.0 * abs(origin.w) / (projectionMatrix[1][1] * uFramePixels * max(length(modelViewMatrix[0].xyz), 1e-6));
  float margin = ${MARGIN_PX.toFixed(1)} * pixel + uMargin;
  vec2 cell = vec2(aIndex.x + 0.5 - 0.5 * uGrid.x, 0.5 * uGrid.y - aIndex.y - 0.5) * uPitch;
  bool home = all(lessThan(abs(aDot.xy - cell), vec2(1e-4 * min(uPitch.x, uPitch.y))));
  vec2 local;
  if (uMerge > 0.0 && home) {
    vec2 edge = vec2(aIndex.x + 0.5 + corner.x - 0.5 * uGrid.x, 0.5 * uGrid.y - aIndex.y - 0.5 + corner.y);
    local = edge * uPitch;
    float ox = (aIndex.x < 0.5 && corner.x < 0.0) ? -1.0 : ((aIndex.x > uGrid.x - 1.5 && corner.x > 0.0) ? 1.0 : 0.0);
    float oy = (aIndex.y < 0.5 && corner.y > 0.0) ? 1.0 : ((aIndex.y > uGrid.y - 1.5 && corner.y < 0.0) ? -1.0 : 0.0);
    local += vec2(ox, oy) * margin;
  } else if (aDot.z > 0.0 && aDot.w > 0.0) {
    // A dot still travelling home swells toward its cell, and the tile blend dilates it by up to another half pitch.
    float half_pitch = 0.5 * max(uPitch.x, uPitch.y);
    float reach = uMerge > 0.0 ? max(aDot.z, half_pitch) + half_pitch : aDot.z;
    local = aDot.xy + corner * 2.0 * (reach + margin);
  } else {
    local = aDot.xy;
  }
  vLocal = local;
  vDot = aDot;
  vTint = aTint;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(local, 0.0, 1.0);
#ifdef KK_FLUID
  ${FLUID_CLIP_VARYING} = clip.xyw;
#endif
  gl_Position = clip;
}
`;

// Each dot is a rounded box (a circle at full roundness); merging grows it to its cell and blends toward the tile's distance, clamped inside so every gap closes at once. Linear colour out through three's own encode, like RoundedRect.
const fragment = (fill: ResolvedFluidFill | null) => /* glsl */ `
${fill ? fluidFillFunction(fill.def.fragment) : ""}
uniform vec2 uPitch;
uniform float uMerge;
uniform float uRound;
uniform vec2 uTileHalf;
uniform float uTileRadius;
uniform vec3 uColor;
uniform float uOpacity;
in vec2 vLocal;
in vec4 vDot;
in vec4 vTint;
#ifdef KK_FLUID
in vec3 ${FLUID_CLIP_VARYING};
#endif
out vec4 kkOut;
float kkBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 kkHalf = mix(vec2(vDot.z), 0.5 * uPitch, uMerge);
  float corner = min(mix(vDot.z * uRound, 0.0, uMerge), min(kkHalf.x, kkHalf.y));
  float d = kkBox(vLocal - vDot.xy, kkHalf, corner);
  if (uMerge > 0.0) {
    float tile = max(kkBox(vLocal, uTileHalf, uTileRadius), -0.5 * min(uPitch.x, uPitch.y));
    d = mix(d, tile, uMerge);
  }
  float aa = max(fwidth(d), 1e-6);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
#ifdef KK_FLUID
  vec4 fluid = clamp(kkFluid(${FLUID_SCREEN_ST}), 0.0, 1.0);
  vec3 base = kkSrgbToLinear(fluid.rgb);
  float baseA = fluid.a;
#else
  vec3 base = uColor;
  float baseA = 1.0;
#endif
  vec3 rgb = mix(base, vTint.rgb, vTint.w);
  float alpha = mix(baseA, 1.0, vTint.w) * coverage * vDot.w * uOpacity;
  kkOut = linearToOutputTexel(vec4(rgb, alpha));
}
`;

function dotMaterial(fill: ResolvedFluidFill | null, format: { width: number; height: number }) {
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    defines: fill ? { KK_FLUID: "" } : {},
    uniforms: {
      ...(fill ? fluidFillUniforms(fill, format) : {}),
      uGrid: { value: new Vector2(1, 1) },
      uPitch: { value: new Vector2(1, 1) },
      uMerge: { value: 0 },
      uMargin: { value: 0 },
      uFramePixels: { value: format.height },
      uRound: { value: 1 },
      uTileHalf: { value: new Vector2(0.5, 0.5) },
      uTileRadius: { value: 0 },
      uColor: { value: new Color(1, 1, 1) },
      uOpacity: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: fragment(fill),
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  return material;
}

function dotGeometry(columns: number, rows: number, frame: DotFieldFrame) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(QUAD_POSITIONS, 3));
  geometry.setIndex(QUAD_INDEX);
  const index = new Float32Array(frame.count * 2);
  for (let i = 0; i < frame.count; i++) {
    index[i * 2] = i % columns;
    index[i * 2 + 1] = Math.floor(i / columns);
  }
  geometry.setAttribute("aIndex", new InstancedBufferAttribute(index, 2));
  const dots = new InstancedBufferAttribute(frame.dots, 4);
  dots.setUsage(DynamicDrawUsage);
  geometry.setAttribute("aDot", dots);
  const tints = new InstancedBufferAttribute(frame.tints, 4);
  tints.setUsage(DynamicDrawUsage);
  geometry.setAttribute("aTint", tints);
  geometry.instanceCount = columns * rows;
  return geometry;
}

function tokenHex(theme: Theme, value: string | undefined, fallback: keyof Theme["colors"]) {
  return (value === undefined ? null : themeColourHex(theme, value)) ?? theme.colors[fallback];
}

function countRuns(count: DotCount | readonly DotCount[] | undefined): readonly DotCount[] {
  if (count === undefined) return [];
  return isRunList(count) ? count : [count];
}

function isRunList(count: DotCount | readonly DotCount[]): count is readonly DotCount[] {
  return Array.isArray(count);
}

const scratch = new Color();

function linearRgb(hex: string): [number, number, number] {
  scratch.set(hex);
  return [scratch.r, scratch.g, scratch.b];
}

/** Hundreds of dots in ONE instanced draw, laid out as a grid or waffle, each dot's size, place and colour a pure function of the authored fields: a pop-in, a halftone wave, a window that clears for a hero number, counts recolouring dots in order as a counter rolls, a funnel, a gather into one dot and a merge into a solid tile. Flat and colour-exact like `RoundedRect`, or filled with the fluid gradient. Drive every field from `useTimeline()`; the field itself reads no clock. */
export function DotField(props: DotFieldProps) {
  const {
    pitch = DEFAULT_PITCH,
    size = DEFAULT_SIZE,
    shape = "circle",
    roundness = DEFAULT_ROUNDNESS,
    color,
    opacity = 1,
    merge = 0,
    tileRadius,
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = 1,
    renderOrder = 0,
  } = props;
  const { columns, rows } = dotGrid(props.columns ?? 10, props.rows ?? 10);
  const theme = useTheme();
  const format = useFormat();
  const group = useContext(GroupAnimationContext);
  const fill = useResolvedFluidFill(props.fill, theme);
  const { width: frameW, height: frameH } = format;
  const material = useMemo(
    () => dotMaterial(fill, { width: frameW, height: frameH }),
    [fill, frameW, frameH],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  const built = useMemo(() => {
    const n = columns * rows;
    const frame: DotFieldFrame = {
      count: n,
      dots: new Float32Array(n * 4),
      tints: new Float32Array(n * 4),
    };
    return { frame, geometry: dotGeometry(columns, rows, frame) };
  }, [columns, rows]);
  useLayoutEffect(() => () => built.geometry.dispose(), [built]);

  const [px, py] = typeof pitch === "number" ? [pitch, pitch] : [pitch[0], pitch[1]];
  const pitchX = Math.abs(Number.isFinite(px) ? px : DEFAULT_PITCH);
  const pitchY = Math.abs(Number.isFinite(py) ? py : DEFAULT_PITCH);
  const runs = countRuns(props.count);
  const counts: DotCountRun[] = runs.map((run) => ({
    value: run.value,
    rgb: linearRgb(tokenHex(theme, run.color, "muted")),
  }));

  // Instance data is written in the commit, so the export loop's canvas barrier sees this frame's field before capture.
  useLayoutEffect(() => {
    dotFieldFrame(
      {
        columns,
        rows,
        pitchX,
        pitchY,
        size,
        reveal: props.reveal,
        wave: props.wave,
        window: props.window,
        counts,
        countOrder: runs[0]?.order,
        countSeed: runs[0]?.seed,
        funnel: props.funnel,
        gather: props.gather,
        merge,
        dot: props.dot,
      },
      built.frame,
    );
    const geometry = built.geometry;
    (geometry.getAttribute("aDot") as InstancedBufferAttribute).needsUpdate = true;
    (geometry.getAttribute("aTint") as InstancedBufferAttribute).needsUpdate = true;
  });

  const u = material.uniforms;
  const m = Math.min(1, Math.max(0, Number.isFinite(merge) ? merge : 0));
  const minPitch = Math.min(pitchX, pitchY);
  const tileHalf: [number, number] = [(columns * pitchX) / 2, (rows * pitchY) / 2];
  u.uGrid.value.set(columns, rows);
  u.uPitch.value.set(pitchX, pitchY);
  u.uMerge.value = m;
  u.uMargin.value = MARGIN_PITCH * minPitch;
  u.uRound.value = shape === "square" ? Math.min(1, Math.max(0, roundness)) : 1;
  u.uTileHalf.value.set(tileHalf[0], tileHalf[1]);
  u.uTileRadius.value = Math.min(
    Math.max(0, tileRadius ?? minPitch / 2),
    Math.min(tileHalf[0], tileHalf[1]),
  );
  u.uColor.value.set(tokenHex(theme, color, "text"));
  u.uOpacity.value = opacity * (group?.alpha ?? 1);

  const speed = fill?.speed ?? 0;
  const beforeRender = useMemo(
    () => () => {
      if (fill) writeFluidTime(material.uniforms, speed);
    },
    [fill, material, speed],
  );

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* Instances move every frame, so the quad's own bounds would cull them. */}
      <mesh
        geometry={built.geometry}
        material={material}
        renderOrder={renderOrder}
        frustumCulled={false}
        onBeforeRender={beforeRender}
      />
    </group>
  );
}
