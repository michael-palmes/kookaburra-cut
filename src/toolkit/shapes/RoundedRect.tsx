import { useContext, useLayoutEffect, useMemo } from "react";
import { Color, ShaderMaterial, Vector2 } from "three";
import { useTheme } from "../../theme";
import { GroupAnimationContext } from "../group/context";
import type { V3 } from "../types";

export interface PillProps {
  /** World-unit width. */
  width: number;
  /** World-unit height. */
  height: number;
  /** Fill colour (a theme token hex); defaults to the theme accent. */
  color?: string;
  opacity?: number;
  /** Border ring width in world units, drawn just inside the edge; 0 or absent draws none. */
  strokeWidth?: number;
  /** Border colour; defaults to the theme text colour. */
  strokeColor?: string;
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
varying vec2 vRectPos;
void main() {
  vec2 q = abs(vRectPos) - 0.5 * uSize + uRadius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float aa = max(fwidth(d), 1e-6);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
  vec3 rgb = uColor;
  if (uStrokeWidth > 0.0) {
    rgb = mix(uColor, uStrokeColor, smoothstep(-aa, aa, d + uStrokeWidth));
  }
  gl_FragColor = vec4(rgb, coverage * uOpacity);
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

/** An unlit, antialiased rounded rectangle with an optional border ring; colour-exact like ImageCard, and size, radius and colours animate without rebuilding geometry. */
export function RoundedRect(props: RoundedRectProps) {
  const {
    width,
    height,
    radius = 0,
    color,
    opacity = 1,
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

/** A RoundedRect whose radius is half the shorter side. */
export function Pill(props: PillProps) {
  return <RoundedRect {...props} radius={Math.min(props.width, props.height) / 2} />;
}
