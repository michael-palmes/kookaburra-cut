import { useContext, useLayoutEffect, useMemo } from "react";
import { Color, ShaderMaterial } from "three";
import { SceneDocContext } from "../../engine/sceneContext";
import { resolveSceneColour } from "../../engine/sceneMosaic";
import {
  DEVICE_TAP_RADIUS_FRACTION,
  screenTaps,
  TAP_RING_RADIUS,
  worldTaps,
} from "../../engine/sceneTaps";
import { tapPulseAt } from "../../engine/tapCurve";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { DeviceScreenAnchor, useDeviceScreen } from "../device/DeviceScreenAnchor";
import type { V3 } from "../types";

/** The ring's outer edge as a fraction of the quad's half size (the editor's default "Dot and ring" stops). */
const RING_OUTER = 0.7;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The video editor's default tap style as alpha stops over the radius (a 0.95 dot to 0.18, a 0.9 ring from 0.56 to 0.64, linear ramps between), then the stock colour-space chunk so a token hex lands exactly.
const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDot;
varying vec2 vUv;
float tapRamp(float a, float b, float x) {
  return clamp((x - a) / (b - a), 0.0, 1.0);
}
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float centre = 0.95 * (1.0 - tapRamp(0.18, 0.26, r)) * uDot;
  float ring = 0.9 * tapRamp(0.5, 0.56, r) * (1.0 - tapRamp(0.64, 0.7, r));
  gl_FragColor = vec4(uColor, max(centre, ring) * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface TapRingProps {
  /** Scene-local ms the pulse starts; it runs the video editor's 550 ms tap curve. */
  at: number;
  /** Outer ring radius at rest scale, world units (default 0.12). */
  radius?: number;
  /** A theme token hex (default the accent). */
  colour?: string;
  /** Draw the centre dot (default true). */
  dot?: boolean;
  position?: V3;
  renderOrder?: number;
}

/** A tap pulse: an analytic ring (and centre dot) popping in, pulsing once and fading on the video editor's tap curve, facing +z. Hidden outside its 550 ms window. */
export function TapRing({
  at,
  radius = TAP_RING_RADIUS,
  colour,
  dot = true,
  position,
  renderOrder = 0,
}: TapRingProps) {
  const { localMs } = useTimeline();
  const theme = useTheme();
  const material = useMemo(() => {
    const m = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(1, 1, 1) },
        uOpacity: { value: 0 },
        uDot: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    m.toneMapped = false;
    return m;
  }, []);
  useLayoutEffect(() => () => material.dispose(), [material]);
  const pulse = tapPulseAt(localMs - at);
  material.uniforms.uColor.value.set(colour ?? theme.colors.accent);
  material.uniforms.uOpacity.value = pulse?.opacity ?? 0;
  material.uniforms.uDot.value = dot ? 1 : 0;
  const half = Math.max(0, radius) / RING_OUTER;
  return (
    <mesh
      position={position}
      scale={(pulse?.scale ?? 1) * half * 2}
      material={material}
      renderOrder={renderOrder}
      visible={pulse !== null && half > 0}
    >
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/** Host-side world-space taps from the sidecar `taps` block (mounted by the scene host beside the other fallbacks); screen taps draw inside their device. */
export function TapsFallback() {
  const doc = useContext(SceneDocContext);
  const theme = useTheme();
  const taps = worldTaps(doc);
  if (taps.length === 0) return null;
  return (
    <>
      {taps.map((tap, i) => (
        <TapRing
          // biome-ignore lint/suspicious/noArrayIndexKey: taps are positional, with no ids
          key={i}
          at={tap.at}
          position={tap.position}
          radius={TAP_RING_RADIUS * (tap.size ?? 1)}
          colour={resolveSceneColour(tap.colour, theme.colors, "accent")}
        />
      ))}
    </>
  );
}

/** Whether a sidecar device has screen taps to draw. */
export function useHasScreenTaps(deviceId: string | undefined): boolean {
  return screenTaps(useContext(SceneDocContext), deviceId).length > 0;
}

/** A sidecar device's screen taps, pinned through `DeviceScreenAnchor`; mount inside the device. */
export function DeviceScreenTaps({ deviceId }: { deviceId: string }) {
  const doc = useContext(SceneDocContext);
  const theme = useTheme();
  const screen = useDeviceScreen();
  if (!screen) return null;
  const base = DEVICE_TAP_RADIUS_FRACTION * screen.rect.width;
  return (
    <>
      {screenTaps(doc, deviceId).map((tap, i) => (
        <DeviceScreenAnchor
          // biome-ignore lint/suspicious/noArrayIndexKey: taps are positional, with no ids
          key={i}
          u={tap.screenUv[0]}
          v={tap.screenUv[1]}
        >
          <TapRing
            at={tap.at}
            radius={base * (tap.size ?? 1)}
            colour={resolveSceneColour(tap.colour, theme.colors, "accent")}
          />
        </DeviceScreenAnchor>
      ))}
    </>
  );
}
