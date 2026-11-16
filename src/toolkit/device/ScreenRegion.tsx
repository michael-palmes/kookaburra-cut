import { useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Color,
  DataTexture,
  type Mesh,
  RGBAFormat,
  ShaderMaterial,
  type Texture,
  Vector2,
} from "three";
import type { ScreenUvMap } from "../../engine/screenFit";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { resolveAvailableDeviceSpec } from "./catalog";
import { DeviceScreenContext } from "./DeviceScreenAnchor";
import { DeviceDisplaysContext } from "./deviceDisplays";
import {
  type DeviceScreenDisplay,
  deviceScreenFrame,
  deviceScreenRect,
  SCREEN_LIFT,
} from "./screenAnchor";
import {
  asRegionDepthMesh,
  REGION_DEPTH_ORDER,
  REGION_VERTEX,
  ROUNDED_BOX,
  regionDepthMaterial,
} from "./screenRegionDepth";
import { glassCardMaterial } from "./screenRegionGlass";
import {
  lensRect,
  type RegionLiftTiming,
  regionLift,
  regionSampling,
  type ScreenUvRect,
} from "./screenRegionMath";

export interface ScreenRegionProps extends RegionLiftTiming {
  /** The card's display rectangle, `[u0, v0, u1, v1]` (u right, v down from the top-left). */
  rect?: ScreenUvRect;
  /** `"lens"`: a round magnifier over `centre` instead of a card. */
  variant?: "card" | "lens";
  /** Lens: the display point it magnifies (default the centre). */
  centre?: [number, number];
  /** Lens radius in fitted units (default 0.32; a phone display is about 1.15 wide). */
  radius?: number;
  /** Lens magnification (default 2). */
  zoom?: number;
  /** How far it rises off the glass at full lift, in fitted units (default 0.35 for a card, 0.22 for a lens). */
  lift?: number;
  /** Size at full lift (default 1.12 for a card, 1 for a lens). */
  scale?: number;
  /** Slide across the display at full lift, `[x, y]` in fitted units (default none). */
  offset?: [number, number];
  /** Card corner radius in fitted units (default 22% of the short side). */
  cornerRadius?: number;
  /** Shadow strength at full lift, 0 to 1 (default 0.35): on the glass under it, and a softer one round its own edge. */
  shadow?: number;
  /** Lens rim colour (default the theme's text colour). */
  rimColour?: string;
  /** A foldable's display (default `"main"`, the inside one). */
  display?: DeviceScreenDisplay;
  /** Card only: render it as glass with a bevel this wide (fitted units), lit by the scene's environment; absent keeps the flat card. */
  glassEdge?: number;
}

// The display's own texture, sampled through the card's slice of it and dimmed by the display's power; a lens adds a rim.
const CARD_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec2 uOrigin;
uniform vec2 uAxisS;
uniform vec2 uAxisT;
uniform vec2 uSize;
uniform float uRadius;
uniform vec3 uTint;
uniform vec4 uRim;
uniform float uRimWidth;
varying vec2 vUv;
${ROUNDED_BOX}
void main() {
  float d = roundedBox((vUv - 0.5) * uSize, 0.5 * uSize, uRadius);
  float aa = max(fwidth(d), 1e-6);
  float coverage = 1.0 - smoothstep(-aa, aa, d);
  if (coverage <= 0.0) discard;
  vec2 tuv = uOrigin + vUv.x * uAxisS + vUv.y * uAxisT;
  vec3 rgb = uHasMap > 0.5 ? texture2D(uMap, tuv).rgb * uTint : vec3(0.0);
  float ring = uRim.a * smoothstep(-aa, aa, d + uRimWidth);
  gl_FragColor = vec4(mix(rgb, uRim.rgb, ring), coverage);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// A blurred rounded box, padded by the blur on every side, falling only on the glass: where a card overhangs the display there is nothing for it to land on.
const SHADOW_FRAGMENT = /* glsl */ `
uniform vec2 uSize;
uniform float uRadius;
uniform float uBlur;
uniform float uOpacity;
uniform vec2 uPlaneCentre;
uniform vec2 uScreenCentre;
uniform vec2 uScreenHalf;
uniform float uScreenRadius;
varying vec2 vUv;
${ROUNDED_BOX}
void main() {
  vec2 p = (vUv - 0.5) * (uSize + 2.0 * uBlur);
  float d = roundedBox(p, 0.5 * uSize, uRadius);
  float glass = roundedBox(p + uPlaneCentre - uScreenCentre, uScreenHalf, uScreenRadius);
  float aa = max(fwidth(glass), 1e-6);
  float a = uOpacity * (1.0 - smoothstep(-uBlur, uBlur, d)) * (1.0 - smoothstep(-aa, aa, glass));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  #include <colorspace_fragment>
}
`;

const IDENTITY_MAP: ScreenUvMap = { rect: { u0: 0, v0: 0, u1: 1, v1: 1 } };
const LENS_RIM_ALPHA = 0.85;

interface CardUniforms {
  [name: string]: { value: unknown };
  uMap: { value: Texture };
  uHasMap: { value: number };
  uOrigin: { value: Vector2 };
  uAxisS: { value: Vector2 };
  uAxisT: { value: Vector2 };
  uSize: { value: Vector2 };
  uRadius: { value: number };
  uTint: { value: Color };
  uRim: { value: [number, number, number, number] };
  uRimWidth: { value: number };
}

interface ShadowUniforms {
  [name: string]: { value: unknown };
  uSize: { value: Vector2 };
  uRadius: { value: number };
  uBlur: { value: number };
  uOpacity: { value: number };
  uPlaneCentre: { value: Vector2 };
  uScreenCentre: { value: Vector2 };
  uScreenHalf: { value: Vector2 };
  uScreenRadius: { value: number };
}

function regionMaterials() {
  const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
  blank.needsUpdate = true;
  const card: CardUniforms = {
    uMap: { value: blank },
    uHasMap: { value: 0 },
    uOrigin: { value: new Vector2() },
    uAxisS: { value: new Vector2(1, 0) },
    uAxisT: { value: new Vector2(0, 1) },
    uSize: { value: new Vector2(1, 1) },
    uRadius: { value: 0 },
    uTint: { value: new Color(1, 1, 1) },
    uRim: { value: [1, 1, 1, 0] },
    uRimWidth: { value: 0 },
  };
  const shadowUniforms = (): ShadowUniforms => ({
    uSize: { value: new Vector2(1, 1) },
    uRadius: { value: 0 },
    uBlur: { value: 0.05 },
    uOpacity: { value: 0 },
    uPlaneCentre: { value: new Vector2() },
    uScreenCentre: { value: new Vector2() },
    uScreenHalf: { value: new Vector2(0.5, 0.5) },
    uScreenRadius: { value: 0 },
  });
  const shadow = shadowUniforms();
  // The card's own soft edge, everywhere it floats: its glass mask opened wide.
  const halo = shadowUniforms();
  halo.uScreenHalf.value.set(1e4, 1e4);
  const make = (uniforms: CardUniforms | ShadowUniforms, fragmentShader: string) => {
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: REGION_VERTEX,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    material.toneMapped = false;
    return material;
  };
  return {
    blank,
    rim: new Color(),
    card,
    shadow,
    halo,
    cardMaterial: make(card, CARD_FRAGMENT),
    shadowMaterial: make(shadow, SHADOW_FRAGMENT),
    haloMaterial: make(halo, SHADOW_FRAGMENT),
    depthMaterial: regionDepthMaterial(card),
  };
}

/** Lifts part of the parent `Device`'s own display towards the camera, a card with a soft shadow on the glass, or a round lens that magnifies a point: the control that matters rising out of the screen, then settling back. It samples the texture the display shows this frame (video or still), so it never adds a decode. A child of `Device`, like `DeviceScreenAnchor`. */
export function ScreenRegion(props: ScreenRegionProps) {
  const {
    variant = "card",
    rect = [0.1, 0.4, 0.9, 0.5],
    centre = [0.5, 0.5],
    radius = 0.32,
    zoom = 2,
    offset = [0, 0],
    shadow = 0.35,
    rimColour,
    display,
  } = props;
  const lens = variant === "lens";
  const lift = props.lift ?? (lens ? 0.22 : 0.35);
  const scale = props.scale ?? (lens ? 1 : 1.12);
  const context = useContext(DeviceScreenContext);
  const displays = useContext(DeviceDisplaysContext);
  const theme = useTheme();
  const { localMs } = useTimeline();
  const parts = useMemo(regionMaterials, []);
  const glassEdge = lens ? 0 : (props.glassEdge ?? 0);
  const glassOn = glassEdge > 0;
  const bevel = useMemo(() => ({ value: 0 }), []);
  const glass = useMemo(
    () => (glassOn ? glassCardMaterial(parts.card, bevel) : null),
    [glassOn, parts, bevel],
  );
  useLayoutEffect(() => () => glass?.dispose(), [glass]);
  bevel.value = glassEdge;
  useLayoutEffect(
    () => () => {
      parts.cardMaterial.dispose();
      parts.shadowMaterial.dispose();
      parts.haloMaterial.dispose();
      parts.depthMaterial.dispose();
      parts.blank.dispose();
    },
    [parts],
  );
  useEffect(() => {
    if (!context) console.warn("ScreenRegion renders nothing outside a <Device>");
  }, [context]);

  const cardRef = useRef<Mesh>(null);
  const model = context?.renderModel ?? "android";
  const screenRect = deviceScreenRect(model, display);
  const region: ScreenUvRect = lens ? lensRect(centre, radius, zoom, screenRect) : rect;
  // A stand-in model's one display shows a foldable's cover media too.
  const coverShown = display === "cover" && resolveAvailableDeviceSpec(model).coverScreen;
  const source = coverShown ? displays?.cover : displays?.main;

  // Read at draw time, never in render: the display's frame binds asynchronously, and the export captures only once it has.
  useLayoutEffect(() => {
    const mesh = cardRef.current;
    if (!mesh || !source) return;
    mesh.onBeforeRender = () => {
      const u = parts.card;
      const map = source.map;
      u.uMap.value = map ?? parts.blank;
      u.uHasMap.value = map ? 1 : 0;
      u.uTint.value.copy(source.color);
      const sampling = regionSampling(source.userData.screenUvMap ?? IDENTITY_MAP, region);
      u.uOrigin.value.set(...sampling.origin);
      u.uAxisS.value.set(...sampling.s);
      u.uAxisT.value.set(...sampling.t);
    };
  });

  if (!context) return null;
  const p = regionLift(localMs, props);
  const width = lens ? 2 * radius : Math.abs(region[2] - region[0]) * screenRect.width;
  const height = lens ? 2 * radius : Math.abs(region[3] - region[1]) * screenRect.height;
  const corner = lens
    ? radius
    : Math.min(props.cornerRadius ?? 0.22 * Math.min(width, height), Math.min(width, height) / 2);
  // A card starts as its own patch of glass; a lens grows in, since its magnified view differs from what it covers.
  const grown = lens ? scale * p : 1 + (scale - 1) * p;
  const u = lens ? centre[0] : (region[0] + region[2]) / 2;
  const v = lens ? centre[1] : (region[1] + region[3]) / 2;
  const anchor = deviceScreenFrame(model, u, v, 0, {
    display,
    lidDeg: context.lidDeg,
    foldDeg: context.foldDeg,
  });

  parts.card.uSize.value.set(width, height);
  parts.card.uRadius.value = corner;
  const rim = parts.rim.set(rimColour ?? theme.colors.text);
  parts.card.uRim.value.splice(0, 4, rim.r, rim.g, rim.b, lens ? LENS_RIM_ALPHA : 0);
  parts.card.uRimWidth.value = lens ? Math.max(0.012, 0.045 * radius) : 0;
  const blur = 0.03 + 0.3 * lift * p;
  const shadowAt: [number, number] = [offset[0] * p, offset[1] * p - 0.4 * lift * p];
  parts.shadow.uSize.value.set(width * grown, height * grown);
  parts.shadow.uRadius.value = corner * grown;
  parts.shadow.uBlur.value = blur;
  parts.shadow.uOpacity.value = Math.min(1, Math.max(0, shadow)) * p;
  parts.shadow.uPlaneCentre.value.set(...shadowAt);
  parts.shadow.uScreenCentre.value.set((0.5 - u) * screenRect.width, (v - 0.5) * screenRect.height);
  parts.shadow.uScreenHalf.value.set(screenRect.width / 2, screenRect.height / 2);
  parts.shadow.uScreenRadius.value = screenRect.cornerRadius;
  const haloBlur = 0.02 + 0.08 * p;
  const cardZ = SCREEN_LIFT * 2 + lift * p;
  parts.halo.uSize.value.set(width * grown, height * grown);
  parts.halo.uRadius.value = corner * grown;
  parts.halo.uBlur.value = haloBlur;
  parts.halo.uOpacity.value = 0.6 * Math.min(1, Math.max(0, shadow)) * p;

  return (
    <group position={anchor.position} rotation={[anchor.tiltX, 0, 0]} visible={p > 0}>
      <mesh
        material={parts.shadowMaterial}
        position={[shadowAt[0], shadowAt[1], SCREEN_LIFT * 1.5]}
        scale={[width * grown + 2 * blur, height * grown + 2 * blur, 1]}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh
        material={parts.haloMaterial}
        position={[offset[0] * p, offset[1] * p - 0.06 * lift * p, cardZ - SCREEN_LIFT]}
        scale={[width * grown + 2 * haloBlur, height * grown + 2 * haloBlur, 1]}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh
        ref={cardRef}
        material={glass ?? parts.cardMaterial}
        position={[offset[0] * p, offset[1] * p, cardZ]}
        scale={[width * grown, height * grown, 1]}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>
      {lift > 0 ? (
        <group renderOrder={REGION_DEPTH_ORDER}>
          <mesh
            ref={asRegionDepthMesh}
            material={parts.depthMaterial}
            position={[offset[0] * p, offset[1] * p, cardZ]}
            scale={[width * grown, height * grown, 1]}
          >
            <planeGeometry args={[1, 1]} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}
