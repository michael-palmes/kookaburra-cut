import { useLayoutEffect, useMemo } from "react";
import { Color, ShaderMaterial, Vector2, Vector4 } from "three";
import { type EmphasisPill, type EmphasisShape, emphasisPills } from "./emphasis";
import { ACCENT_LAYER_Z_EM } from "./HighlightQuads";
import { type StaggerUnits, type TextUnitSample, unitIndexForKey } from "./presets";

/** Where each pill rides this frame: an offset in layout units, a scale about its centre and an opacity (a staggered headline hands its token unit's sample; a block or static one, zero and its alpha). */
export interface EmphasisPillMotion {
  dx: number;
  dy: number;
  scale: number;
  alpha: number;
}

/** Each emphasis rect rides the motion of the stagger unit holding its centre, the highlight-block rule, so a pill moves and fades with its words. */
export function pillMotionsFromUnits(
  rects: Float32Array,
  units: StaggerUnits,
  samples: readonly TextUnitSample[],
  axis: "x" | "-y",
  fontSize: number,
): EmphasisPillMotion[] {
  const motions: EmphasisPillMotion[] = [];
  if (samples.length === 0) return motions;
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const key = axis === "-y" ? -(rects[i + 1] + rects[i + 3]) / 2 : (rects[i] + rects[i + 2]) / 2;
    const sample = samples[Math.min(unitIndexForKey(units, key), samples.length - 1)];
    motions.push({
      dx: sample.dxEm * fontSize,
      dy: sample.dyEm * fontSize,
      scale: sample.scale,
      alpha: sample.alpha,
    });
  }
  return motions;
}

const VERTEX = /* glsl */ `
uniform vec2 uExtent;
varying vec2 vPos;
void main() {
  vPos = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The outline is a band just inside the body's edge, trimmed by arc length from the left middle, clockwise, so it traces on like a pen; the fill floods the body and the terminal pops in as the trace passes it. Linear colour out through the stock chunks, like RoundedRect.
const FRAGMENT = /* glsl */ `
uniform vec2 uHalf;
uniform float uRadius;
uniform float uStroke;
uniform vec3 uColor;
uniform float uDraw;
uniform float uFill;
uniform float uOpacity;
uniform vec4 uNub;
uniform float uNubRadius;
varying vec2 vPos;
float kkBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float kkArc(vec2 p, vec2 b, float r) {
  float ex = b.x - r;
  float ey = b.y - r;
  float qa = 1.5707963 * r;
  if (p.x < -ex && p.y > ey) return ey + r * (3.1415927 - atan(p.y - ey, p.x + ex));
  if (p.x > ex && p.y > ey) return ey + qa + 2.0 * ex + r * (1.5707963 - atan(p.y - ey, p.x - ex));
  if (p.x > ex && p.y < -ey) return ey + 2.0 * qa + 2.0 * ex + 2.0 * ey - r * atan(p.y + ey, p.x - ex);
  if (p.x < -ex && p.y < -ey) return ey + 3.0 * qa + 4.0 * ex + 2.0 * ey + r * (-1.5707963 - atan(p.y + ey, p.x + ex));
  float dl = p.x + b.x;
  float dr = b.x - p.x;
  float dt = b.y - p.y;
  float db = p.y + b.y;
  float m = min(min(dl, dr), min(dt, db));
  if (m == dt) return ey + qa + p.x + ex;
  if (m == dr) return ey + 2.0 * qa + 2.0 * ex + ey - p.y;
  if (m == db) return ey + 3.0 * qa + 2.0 * ex + 2.0 * ey + ex - p.x;
  return p.y >= 0.0 ? p.y : 4.0 * ex + 4.0 * ey + 4.0 * qa + p.y;
}
void main() {
  float d = kkBox(vPos, uHalf, uRadius);
  float aa = max(fwidth(d), 1e-6);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float band = smoothstep(-aa, aa, d + uStroke) - smoothstep(-aa, aa, d);
  vec2 line = uHalf - 0.5 * uStroke;
  float lineR = max(0.0, uRadius - 0.5 * uStroke);
  float perimeter = 4.0 * (line.x - lineR) + 4.0 * (line.y - lineR) + 6.2831853 * lineR;
  float s = kkArc(vPos, line, lineR);
  float traced = uDraw >= 1.0 ? 1.0 : (uDraw <= 0.0 ? 0.0 : 1.0 - smoothstep(-aa, aa, s - uDraw * perimeter));
  float body = max(band * traced, inside * uFill);
  float nub = 0.0;
  if (uNub.z > 0.0) {
    float dn = kkBox(vPos - uNub.xy, uNub.zw, uNubRadius);
    nub = (1.0 - smoothstep(-aa, aa, dn)) * clamp((uDraw - 0.5) * 12.0, 0.0, 1.0);
  }
  gl_FragColor = vec4(uColor, max(body, nub) * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function pillMaterial() {
  const material = new ShaderMaterial({
    uniforms: {
      uExtent: { value: new Vector2(1, 1) },
      uHalf: { value: new Vector2(0.5, 0.5) },
      uRadius: { value: 0 },
      uStroke: { value: 0 },
      uColor: { value: new Color(1, 1, 1) },
      uDraw: { value: 0 },
      uFill: { value: 0 },
      uOpacity: { value: 1 },
      uNub: { value: new Vector4(0, 0, 0, 0) },
      uNubRadius: { value: 0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  material.toneMapped = false;
  return material;
}

/** AA room round the shape, as a fraction of the font size. */
const MARGIN_EM = 0.08;

function PillMesh(props: {
  pill: EmphasisPill;
  color: string;
  draw: number;
  fill: number;
  motion: EmphasisPillMotion;
  fontSize: number;
}) {
  const { pill, color, draw, fill, motion, fontSize } = props;
  const material = useMemo(pillMaterial, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  const margin = MARGIN_EM * fontSize;
  const nubReach = pill.nub ? pill.nub.cx - pill.cx + pill.nub.halfW : pill.halfW;
  // The quad is centred on the body and wide enough for a terminal on either side.
  const extentX = 2 * (Math.max(pill.halfW, nubReach) + margin);
  const extentY = 2 * (pill.halfH + margin);
  const u = material.uniforms;
  u.uExtent.value.set(extentX, extentY);
  u.uHalf.value.set(pill.halfW, pill.halfH);
  u.uRadius.value = Math.min(pill.radius, pill.halfW, pill.halfH);
  u.uStroke.value = pill.stroke;
  u.uColor.value.set(color);
  u.uDraw.value = draw;
  u.uFill.value = fill;
  u.uOpacity.value = motion.alpha;
  if (pill.nub) {
    u.uNub.value.set(pill.nub.cx - pill.cx, pill.nub.cy - pill.cy, pill.nub.halfW, pill.nub.halfH);
    u.uNubRadius.value = pill.nub.radius;
  } else {
    u.uNub.value.set(0, 0, 0, 0);
  }
  return (
    <mesh
      material={material}
      position={[pill.cx + motion.dx, pill.cy + motion.dy, ACCENT_LAYER_Z_EM * fontSize]}
      scale={[extentX * motion.scale, extentY * motion.scale, 1]}
      visible={motion.alpha > 0 && (draw > 0 || fill > 0)}
    >
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/** The shapes of a shaped emphasis, behind the words in the text's own layout space: one mesh per pill, so a few tokens cost a few draws. `motions` holds one entry per pill (or one for all). */
export function EmphasisPills(props: {
  rects: Float32Array;
  shape: EmphasisShape;
  color: string;
  fontSize: number;
  draw: number;
  fill: number;
  motions: readonly EmphasisPillMotion[];
}) {
  const { rects, shape, color, fontSize, draw, fill, motions } = props;
  const pills = useMemo(() => emphasisPills(rects, fontSize, shape), [rects, fontSize, shape]);
  if (pills.length === 0 || motions.length === 0) return null;
  return (
    <>
      {pills.map((pill, i) => (
        <PillMesh
          // biome-ignore lint/suspicious/noArrayIndexKey: pills are positional, one per emphasis rect
          key={i}
          pill={pill}
          color={color}
          draw={draw}
          fill={fill}
          motion={motions[Math.min(pill.rect, motions.length - 1)]}
          fontSize={fontSize}
        />
      ))}
    </>
  );
}
