import { useContext, useEffect, useLayoutEffect, useMemo } from "react";
import { Color, ShaderMaterial, SRGBColorSpace, Vector2 } from "three";
import { useFormat } from "../../engine/format";
import { useHeldLocalMs } from "../../engine/presentHold";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { useSceneContext } from "../../engine/sceneContext";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import type { Theme } from "../../theme/tokens";
import { GroupAnimationContext } from "../group/context";
import { type MotionKey, sampleKeys } from "../motion/sampleKeys";

type Colour = "background" | "text" | "muted" | "accent" | (string & {});

/** What every fill shares: an opacity and keys over any of its numbers (`tMs` is scene-local). */
export interface ScreenFillProps {
  /** 0..1 (default 1). */
  opacity?: number;
  /** Keyframes over `opacity` and the fill's numeric props; a key's `ease` shapes the segment arriving at it. */
  keys?: readonly MotionKey[];
}

export interface GradientProps extends ScreenFillProps {
  /** Start colour: a theme token or hex. */
  from: Colour;
  /** End colour: a theme token or hex. */
  to: Colour;
  /** "linear" (default) runs along `angleDeg`; "radial" runs from `centre` outward. */
  kind?: "linear" | "radial";
  /** Direction `from` runs toward `to`, degrees clockwise from up (default 180, top to bottom). */
  angleDeg?: number;
  /** Radial centre, frame fractions from the bottom left (default [0.5, 0.5]). */
  centre?: readonly [number, number];
  /** Where along the run the blend starts, 0..1 (default 0). */
  start?: number;
  /** Where along the run the blend ends, 0..1 (default 1). */
  end?: number;
}

export interface ScrimProps extends ScreenFillProps {
  /** The colour it deepens to: a theme token or hex (default "background"). */
  to?: Colour;
  /** "linear" (default) deepens along `angleDeg`; "radial" deepens from `centre` outward. */
  kind?: "linear" | "radial";
  /** Direction it deepens, degrees clockwise from up (default 180, solid at the bottom). */
  angleDeg?: number;
  /** Radial centre, frame fractions from the bottom left (default [0.5, 0.5]). */
  centre?: readonly [number, number];
  /** Where along the run it starts to show, 0..1 (default 0). */
  start?: number;
  /** Where along the run it goes solid, 0..1 (default 1). */
  end?: number;
}

export interface VignetteProps extends ScreenFillProps {
  /** The edge colour: a theme token or hex (default black). */
  colour?: Colour;
  /** How far in the clear centre reaches, 0..1 (default 0.45). */
  start?: number;
  /** How far out it reaches full strength, 0..1 (default 1). */
  end?: number;
}

const KIND_ID = { linear: 0, radial: 1 } as const;
const DEG2RAD = Math.PI / 180;
const SRGB_OUT = { r: 0, g: 0, b: 0 };

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Blends in display space (the lift maths), then hands three linear so every target encodes it its own way; the half-LSB noise is a pure function of the pixel, so a soft ramp can't band at 8 bits.
const FRAGMENT = /* glsl */ `
uniform vec3 uFrom;
uniform vec3 uTo;
uniform float uFromAlpha;
uniform float uToAlpha;
uniform float uOpacity;
uniform float uKind;
uniform float uAngle;
uniform vec2 uCentre;
uniform vec2 uRange;
uniform float uAspect;
varying vec2 vUv;
void main() {
  float run;
  if (uKind > 0.5) {
    vec2 d = (vUv - uCentre) * vec2(uAspect, 1.0);
    vec2 far = max(uCentre, 1.0 - uCentre) * vec2(uAspect, 1.0);
    run = length(d) / length(far);
  } else {
    vec2 axis = vec2(sin(uAngle), cos(uAngle));
    vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
    float reach = abs(axis.x) * uAspect * 0.5 + abs(axis.y) * 0.5;
    run = dot(d, axis) / (2.0 * reach) + 0.5;
  }
  float t = smoothstep(uRange.x, max(uRange.y, uRange.x + 0.0001), run);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 colour = mix(uFrom, uTo, t) + (noise - 0.5) / 255.0;
  float alpha = mix(uFromAlpha, uToAlpha, t) * uOpacity;
  if (alpha < 1.0 && alpha > 0.0) alpha = clamp(alpha + (noise - 0.5) / 255.0, 0.0, 1.0);
  gl_FragColor = vec4(sRGBTransferEOTF(vec4(clamp(colour, 0.0, 1.0), 1.0)).rgb, alpha);
  #include <colorspace_fragment>
}`;

function resolveColour(theme: Theme, colour: Colour): string {
  return Object.hasOwn(theme.colors, colour)
    ? theme.colors[colour as keyof Theme["colors"]]
    : colour;
}

const _colour = new Color();

function writeSrgb(target: Color, hex: string): void {
  _colour.set(hex).getRGB(SRGB_OUT, SRGBColorSpace);
  target.setRGB(SRGB_OUT.r, SRGB_OUT.g, SRGB_OUT.b);
}

interface FillSpec {
  from: Colour;
  to: Colour;
  fromAlpha: number;
  toAlpha: number;
  kind: "linear" | "radial";
  angleDeg: number;
  centre: readonly [number, number];
  start: number;
  end: number;
  opacity: number;
  keys?: readonly MotionKey[];
}

/** The fill's numbers at `localMs`: keys override the props they name, and opacity stays 0..1. */
export function sampleScreenFill(
  spec: Pick<FillSpec, "opacity" | "angleDeg" | "start" | "end" | "keys">,
  localMs: number,
): { opacity: number; angleDeg: number; start: number; end: number } {
  const sampled = spec.keys?.length
    ? (sampleKeys(spec.keys, localMs) as Partial<Record<string, unknown>>)
    : null;
  const num = (name: "opacity" | "angleDeg" | "start" | "end") => {
    const v = sampled?.[name];
    return typeof v === "number" ? v : spec[name];
  };
  return {
    opacity: Math.min(1, Math.max(0, num("opacity"))),
    angleDeg: num("angleDeg"),
    start: num("start"),
    end: num("end"),
  };
}

/** A frame-filling quad at the layer's content plane. A keyed fill holds Present and stills until its last key lands. */
function ScreenFill(spec: FillSpec) {
  const format = useFormat();
  const theme = useTheme();
  const group = useContext(GroupAnimationContext);
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const sample = sampleScreenFill(spec, localMs);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uFrom: { value: new Color() },
          uTo: { value: new Color() },
          uFromAlpha: { value: 1 },
          uToAlpha: { value: 1 },
          uOpacity: { value: 1 },
          uKind: { value: 0 },
          uAngle: { value: 0 },
          uCentre: { value: new Vector2(0.5, 0.5) },
          uRange: { value: new Vector2(0, 1) },
          uAspect: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  const u = material.uniforms;
  writeSrgb(u.uFrom.value as Color, resolveColour(theme, spec.from));
  writeSrgb(u.uTo.value as Color, resolveColour(theme, spec.to));
  u.uFromAlpha.value = spec.fromAlpha;
  u.uToAlpha.value = spec.toAlpha;
  u.uOpacity.value = sample.opacity * (group?.alpha ?? 1);
  u.uKind.value = KIND_ID[spec.kind];
  u.uAngle.value = sample.angleDeg * DEG2RAD;
  (u.uCentre.value as Vector2).set(spec.centre[0], spec.centre[1]);
  (u.uRange.value as Vector2).set(sample.start, sample.end);
  u.uAspect.value = format.aspect;

  const sceneIndex = useSceneContext()?.index;
  const lastKeyMs = spec.keys?.length ? Math.max(...spec.keys.map((k) => k.tMs)) : null;
  useEffect(() => {
    if (sceneIndex === undefined || lastKeyMs === null) return;
    return registerPresentTiming(sceneIndex, { kind: "group", toMs: lastKeyMs });
  }, [sceneIndex, lastKeyMs]);

  return (
    <mesh material={material} frustumCulled={false}>
      <planeGeometry args={[format.frame.width, format.frame.height]} />
    </mesh>
  );
}

/** A frame-filling blend between two colours, linear or radial. Mount inside a `ScreenLayer`. */
export function Gradient({
  from,
  to,
  kind = "linear",
  angleDeg = 180,
  centre = CENTRED,
  start = 0,
  end = 1,
  opacity = 1,
  keys,
}: GradientProps) {
  return (
    <ScreenFill
      from={from}
      to={to}
      fromAlpha={1}
      toAlpha={1}
      kind={kind}
      angleDeg={angleDeg}
      centre={centre}
      start={start}
      end={end}
      opacity={opacity}
      keys={keys}
    />
  );
}

/** Clear to a colour, linear or radial, for text to sit on. Mount inside a `ScreenLayer`. */
export function Scrim({
  to = "background",
  kind = "linear",
  angleDeg = 180,
  centre = CENTRED,
  start = 0,
  end = 1,
  opacity = 1,
  keys,
}: ScrimProps) {
  return (
    <ScreenFill
      from={to}
      to={to}
      fromAlpha={0}
      toAlpha={1}
      kind={kind}
      angleDeg={angleDeg}
      centre={centre}
      start={start}
      end={end}
      opacity={opacity}
      keys={keys}
    />
  );
}

/** Darkened edges, clear centre. Mount inside a `ScreenLayer`. */
export function Vignette({
  colour = "#000000",
  start = 0.45,
  end = 1,
  opacity = 0.6,
  keys,
}: VignetteProps) {
  return (
    <ScreenFill
      from={colour}
      to={colour}
      fromAlpha={0}
      toAlpha={1}
      kind="radial"
      angleDeg={0}
      centre={CENTRED}
      start={start}
      end={end}
      opacity={opacity}
      keys={keys}
    />
  );
}

const CENTRED = [0.5, 0.5] as const;
