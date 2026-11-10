import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type Camera,
  Color,
  DepthTexture,
  FloatType,
  type Matrix4,
  type Mesh,
  MeshBasicMaterial,
  NearestFilter,
  Object3D,
  type PerspectiveCamera,
  type Points,
  type Scene,
  type ShaderMaterial,
  type SpotLight,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { useTimeline } from "../../../engine/timeline";
import { createBeamDust, createBeamMaterial } from "./beamParts";
import { GOBO_DEFAULTS, type GoboSpec, goboTexture } from "./gobo";
import { type GrateSpec, grateTexture } from "./grate";
import { renderOccluders } from "./occlusionPass";

type V3 = [number, number, number];

export interface BeamHaze {
  /** Scattering per world unit. */
  density: number;
  /** Henyey-Greenstein g: 0 even, toward 1 glows looking into the light. */
  anisotropy: number;
  /** 0 smooth air, 1 drifting wisps. */
  noise: number;
  noiseScale: number;
  /** World units per second the wisps drift. */
  drift: V3;
  /** Density thins with height above the floor at this rate (0 = even). */
  heightFalloff: number;
  /** In-scatter gain against the light's surface intensity. */
  strength: number;
  /** Weight of a sharp second forward lobe: the haze round the source glows hot. */
  hotspot: number;
  /** Height over which the haze thins into the floor, so a ray never ends on a hard line where it meets the ground (0 = off). */
  groundFade?: number;
}

export const BEAM_HAZE_DEFAULTS: BeamHaze = {
  density: 0.35,
  anisotropy: 0.55,
  noise: 0.6,
  noiseScale: 0.55,
  drift: [0.05, 0.02, 0.03],
  heightFalloff: 0,
  strength: 1,
  hotspot: 0,
};

/** Smoke the shafts pass through: a seeded field that drifts and churns with the clock alone. */
export interface BeamSmoke {
  /** Feature scale. Keep the shapes large (0.2 is about five units): edge-on rays average the smoke along a long path, which washes out small wisps. */
  scale: number;
  /** How far a slower field folds the smoke into wisps. */
  warp: number;
  warpScale: number;
  /** The noise band mapped onto [floor, 1]. */
  contrast: [number, number];
  floor: number;
  /** World units per second. */
  drift: V3;
  /** How fast the smoke churns in place. */
  evolve: number;
  warpEvolve: number;
  offset: V3;
  /** Thins the smoke in front of the subject: density falls to `min` between `z0` and `z1`. */
  frontFade?: { z0: number; z1: number; min: number };
}

export const BEAM_SMOKE_DEFAULTS: BeamSmoke = {
  scale: 0.2,
  warp: 1.2,
  warpScale: 0.1,
  contrast: [0.38, 0.62],
  floor: 0.05,
  drift: [0.25, 0.18, 0],
  evolve: 0.12,
  warpEvolve: 0.06,
  offset: [3.1, 7.7, 1.3],
};

/** Motes that glint only where a shaft lights them: seeded, drifting with the clock and wrapping inside a box. Keep them few, small and dim, or they read as a starfield. */
export interface BeamDust {
  count: number;
  min: V3;
  max: V3;
  /** Each mote's radius is picked in this range, world units. */
  radius: [number, number];
  seed: number;
  /** World units per second. */
  drift: V3;
  /** How far each mote wanders off its drift. */
  jitter: number;
  jitterScale: number;
  jitterSpeed: number;
  color: string;
  /** How much a mote glows when lit from behind (Henyey-Greenstein g). */
  forward: number;
  gain: number;
}

export const BEAM_DUST_DEFAULTS: BeamDust = {
  count: 1800,
  min: [-8, -1, -9],
  max: [0, 6, 1],
  radius: [0.002, 0.006],
  seed: 11,
  drift: [0.08, 0.1, 0],
  jitter: 0.35,
  jitterScale: 0.5,
  jitterSpeed: 0.3,
  color: "#b8a890",
  forward: 0.6,
  gain: 1,
};

/** The share of `haze.density` the smoke averages, for the extinction estimate along light paths. */
const SMOKE_MEAN = 0.45;
const LIGHT_COLOR = new Color();
const EVOLVE_DIR = new Vector3(0.31, -0.57, 0.76).normalize();
const WARP_DIR = new Vector3(-0.62, 0.21, 0.75).normalize();

export interface VolumetricSpotProps {
  position: V3;
  target: V3;
  /** Full cone, degrees. */
  angleDeg: number;
  penumbra: number;
  color: string;
  intensity: number;
  decay?: number;
  /** Cutoff distance; 0 runs to the beam's own reach. */
  distance?: number;
  gobo?: Partial<GoboSpec> | null;
  /** Bars aimed at the lens (replaces `gobo`): crisp rays fanning from the source. `position` and `target` must be world space. */
  grate?: GrateSpec;
  /** Haze only inside this world box, like a stage's smoke. */
  box?: { min: V3; max: V3 };
  /** Moving smoke in place of `haze.noise`. */
  smoke?: Partial<BeamSmoke>;
  /** The haze dims light on its way in and out, as real smoke does. */
  extinction?: boolean;
  dust?: Partial<BeamDust>;
  castShadow?: boolean;
  shadowMapSize?: number;
  shadowBias?: number;
  /** Softness of the VSM shadow (blur radius in texels). */
  shadowRadius?: number;
  haze?: Partial<BeamHaze>;
  /** Mount the real light, so surfaces catch pools; off draws the beam alone. */
  lightsSurfaces?: boolean;
  /** Draw the beam; off leaves only the light (the gobo pools). */
  beam?: boolean;
  floorY?: number;
  /** How far the beam proxy reaches when `distance` is 0. */
  reach?: number;
  /** Haze in front of the product too: a depth pre-pass stops each ray at the real surface (one extra depth render a frame). */
  veil?: boolean;
}

const FLOOR_LIFT = 0.004;
const SHADOW_NEAR = 0.5;
const SHADOW_FAR = 40;

/** Axis-aligned bounds of the cone from `apex` along `axis`, `reach` long, clipped above the floor. */
function coneBox(apex: Vector3, axis: Vector3, halfAngle: number, reach: number, floorY: number) {
  const up = Math.abs(axis.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = new Vector3().crossVectors(axis, up).normalize();
  const v = new Vector3().crossVectors(axis, u).normalize();
  const r = Math.tan(halfAngle) * reach;
  const min = apex.clone();
  const max = apex.clone();
  const end = apex.clone().addScaledVector(axis, reach);
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const p = end
      .clone()
      .addScaledVector(u, Math.cos(a) * r)
      .addScaledVector(v, Math.sin(a) * r);
    min.min(p);
    max.max(p);
  }
  min.y = Math.max(min.y, floorY + FLOOR_LIFT);
  max.y = Math.max(max.y, min.y + 0.1);
  return { min, max };
}

/** Prototype: a spot light whose beam is visible in haze. The real light (with its cookie and VSM shadow) lights surfaces; a proxy box marches the same cone, cookie and shadow map, so the shafts line up with the pools and anything that casts cuts a shadow shaft. */
export function VolumetricSpot(props: VolumetricSpotProps) {
  const {
    position,
    target,
    angleDeg,
    penumbra,
    color,
    intensity,
    decay = 1.2,
    distance = 0,
    castShadow = false,
    shadowMapSize = 1024,
    shadowBias = -0.0005,
    shadowRadius = 3,
    lightsSurfaces = true,
    beam = true,
    floorY = -1.5,
    reach = 40,
    veil = false,
  } = props;
  const haze = { ...BEAM_HAZE_DEFAULTS, ...props.haze };
  const gobo = props.gobo === null || props.grate ? null : { ...GOBO_DEFAULTS, ...props.gobo };
  const goboKey = gobo ? JSON.stringify(gobo) : "";
  const grateKey = props.grate ? JSON.stringify([props.grate, position, target, angleDeg]) : "";
  const smoke = props.smoke ? { ...BEAM_SMOKE_DEFAULTS, ...props.smoke } : null;
  const boxKey = props.box ? JSON.stringify(props.box) : "";
  const dust = props.dust ? { ...BEAM_DUST_DEFAULTS, ...props.dust } : null;
  const dustKey = dust ? JSON.stringify([dust.count, dust.seed]) : "";
  const extinction = props.extinction ?? false;
  const groundFade = Math.max(0, haze.groundFade ?? 0);
  const time = useTimeline();
  const lightRef = useRef<SpotLight>(null);
  const meshRef = useRef<Mesh>(null);
  const targetObject = useMemo(() => new Object3D(), []);
  const halfAngle = (angleDeg * Math.PI) / 360;

  const map = useMemo(() => {
    if (grateKey) {
      const [grate, p, t, a] = JSON.parse(grateKey) as [GrateSpec, V3, V3, number];
      return grateTexture(grate, { position: p, target: t, halfAngle: (a * Math.PI) / 360 });
    }
    return goboKey ? goboTexture(JSON.parse(goboKey)) : null;
  }, [goboKey, grateKey]);

  const poseKey = `${position.join(",")}|${target.join(",")}`;
  const geometry = useMemo(() => {
    const [p, t] = poseKey.split("|").map((s) => s.split(",").map(Number));
    const apex = new Vector3(p[0], p[1], p[2]);
    const axis = new Vector3(t[0], t[1], t[2]).sub(apex).normalize();
    const { min, max } = coneBox(apex, axis, halfAngle, distance > 0 ? distance : reach, floorY);
    if (boxKey) {
      const box = JSON.parse(boxKey) as { min: V3; max: V3 };
      const lo = new Vector3(...box.min);
      const hi = new Vector3(...box.max);
      const cutMin = min.clone().max(lo);
      const cutMax = max.clone().min(hi);
      const empty = cutMax.x <= cutMin.x || cutMax.y <= cutMin.y || cutMax.z <= cutMin.z;
      min.copy(empty ? lo : cutMin);
      max.copy(empty ? hi : cutMax);
    }
    const box = new BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
    box.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    return box;
  }, [poseKey, halfAngle, distance, reach, floorY, boxKey]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const hasBox = boxKey !== "";
  const hasSmoke = smoke !== null;
  const hasGround = groundFade > 0;
  const material = useMemo(
    () => createBeamMaterial({ box: hasBox, smoke: hasSmoke, extinction, ground: hasGround }),
    [hasBox, hasSmoke, extinction, hasGround],
  );

  const dustPoints = useMemo(() => {
    if (!dustKey) return null;
    const [count, seed] = JSON.parse(dustKey) as [number, number];
    return createBeamDust(count, seed);
  }, [dustKey]);
  useLayoutEffect(
    () => () => {
      dustPoints?.geometry.dispose();
      dustPoints?.material.dispose();
    },
    [dustPoints],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

  // The veil's depth pre-pass: opaque content only, at the size of whatever the beam draws into.
  const depthPass = useMemo(() => {
    const depthTexture = new DepthTexture(1, 1, FloatType);
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    return {
      target: new WebGLRenderTarget(1, 1, { depthBuffer: true, depthTexture }),
      material: new MeshBasicMaterial({ colorWrite: false }),
    };
  }, []);
  useLayoutEffect(
    () => () => {
      depthPass.target.dispose();
      depthPass.target.depthTexture?.dispose();
      depthPass.material.dispose();
    },
    [depthPass],
  );

  const seconds = time.globalMs / 1000;
  useLayoutEffect(() => {
    const u = material.uniforms;
    u.uCosOuter.value = Math.cos(halfAngle);
    u.uCosInner.value = Math.cos(halfAngle * (1 - penumbra));
    u.uRange.value = distance;
    u.uDecay.value = decay;
    (u.uRadiance.value as Color).set(color).multiplyScalar(intensity * haze.strength);
    u.uDensity.value = haze.density;
    u.uG.value = haze.anisotropy;
    u.uFloorY.value = floorY;
    u.uHeightFalloff.value = haze.heightFalloff;
    u.uNoiseScale.value = haze.noiseScale;
    u.uNoiseAmount.value = haze.noise;
    (u.uDrift.value as Vector3).set(
      haze.drift[0] * seconds,
      haze.drift[1] * seconds,
      haze.drift[2] * seconds,
    );
    u.uGobo.value = map;
    u.uGoboOn.value = map ? 1 : 0;
    u.uShadowBias.value = shadowBias;
    u.uHotspot.value = haze.hotspot;
    u.uVeilOn.value = veil ? 1 : 0;
    material.depthTest = !veil;
    if (props.box) {
      (u.uBoxMin.value as Vector3).set(...props.box.min);
      (u.uBoxMax.value as Vector3).set(...props.box.max);
    }
    if (smoke) {
      u.uSmokeScale.value = smoke.scale;
      u.uSmokeWarp.value = smoke.warp;
      u.uSmokeWarpScale.value = smoke.warpScale;
      (u.uSmokeContrast.value as Vector2).set(smoke.contrast[0], smoke.contrast[1]);
      u.uSmokeFloor.value = smoke.floor;
      (u.uSmokeShift.value as Vector3).set(...smoke.drift).multiplyScalar(seconds);
      (u.uWarpShift.value as Vector3).copy(WARP_DIR).multiplyScalar(smoke.warpEvolve * seconds);
      (u.uSmokeOffset.value as Vector3)
        .set(...smoke.offset)
        .addScaledVector(EVOLVE_DIR, smoke.evolve * seconds);
      const fade = smoke.frontFade;
      (u.uFrontFade.value as Vector3).set(fade?.z0 ?? 0, fade?.z1 ?? 1, fade?.min ?? 1);
    }
    u.uGroundFade.value = groundFade > 0 ? groundFade : 1;
    u.uMeanDensity.value =
      haze.density * (smoke ? smoke.floor + (1 - smoke.floor) * SMOKE_MEAN : 1);
    if (dust && dustPoints) {
      const d = dustPoints.material.uniforms;
      (d.uMin.value as Vector3).set(...dust.min);
      (d.uMax.value as Vector3).set(...dust.max);
      (d.uShift.value as Vector3).set(...dust.drift).multiplyScalar(seconds);
      (d.uWander.value as Vector3).copy(WARP_DIR).multiplyScalar(dust.jitterSpeed * seconds);
      d.uJitter.value = dust.jitter;
      d.uJitterScale.value = dust.jitterScale;
      (d.uRadius.value as Vector2).set(dust.radius[0], dust.radius[1]);
      d.uCosOuter.value = u.uCosOuter.value;
      d.uCosInner.value = u.uCosInner.value;
      d.uDecay.value = decay;
      d.uG.value = dust.forward;
      d.uGobo.value = map;
      d.uGoboOn.value = map ? 1 : 0;
      d.uShadowBias.value = shadowBias;
      (d.uColor.value as Color)
        .set(dust.color)
        .multiply(LIGHT_COLOR.set(color))
        .multiplyScalar(intensity * dust.gain);
    }
  });

  // Per draw: the light's world pose and shadow matrix are only final once the renderer has updated them for this render.
  const syncLight = useMemo(() => {
    const aim = new Vector3();
    return (u: ShaderMaterial["uniforms"]) => {
      const light = lightRef.current;
      if (!light) return false;
      const apex = u.uApex.value as Vector3;
      light.getWorldPosition(apex);
      targetObject.getWorldPosition(aim);
      (u.uAxis.value as Vector3).copy(aim.sub(apex).normalize());
      light.shadow.updateMatrices(light);
      (u.uLightMatrix.value as Matrix4).copy(light.shadow.matrix);
      const shadowMap = light.castShadow ? light.shadow.map : null;
      u.uShadowMap.value = shadowMap ? shadowMap.texture : null;
      u.uShadowOn.value = shadowMap ? 1 : 0;
      return true;
    };
  }, [targetObject]);

  const onDustBeforeRender = useMemo(() => {
    const size = new Vector2();
    return (renderer: WebGLRenderer, _scene: Scene, camera: Camera) => {
      if (!dustPoints) return;
      const u = dustPoints.material.uniforms;
      syncLight(u);
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const fov = ((camera as PerspectiveCamera).fov ?? 45) * (Math.PI / 180);
      u.uPxPerUnit.value = size.y / (2 * Math.tan(fov / 2));
    };
  }, [dustPoints, syncLight]);

  const onBeforeRender = useMemo(() => {
    const size = new Vector2();
    return (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
      const u = material.uniforms;
      if (!syncLight(u)) return;
      if (u.uVeilOn.value < 0.5) return;
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const { target } = depthPass;
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      renderOccluders(renderer, scene, camera, target, depthPass.material, 0x000000);
      const cam = camera as PerspectiveCamera;
      u.uSceneDepth.value = target.depthTexture;
      (u.uDepthSize.value as Vector2).set(target.width / size.x, target.height / size.y);
      cam.getWorldDirection(u.uCamForward.value as Vector3);
      u.uCamNear.value = cam.near;
      u.uCamFar.value = cam.far;
    };
  }, [material, depthPass, syncLight]);

  return (
    <>
      <spotLight
        ref={lightRef}
        position={position}
        intensity={lightsSurfaces ? intensity : 0}
        color={color}
        angle={halfAngle}
        penumbra={penumbra}
        distance={distance}
        decay={decay}
        target={targetObject}
        map={map}
        castShadow={castShadow}
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
        shadow-bias={shadowBias}
        shadow-radius={shadowRadius}
        shadow-blurSamples={8}
        shadow-camera-near={SHADOW_NEAR}
        shadow-camera-far={distance > 0 ? distance : SHADOW_FAR}
      />
      <primitive object={targetObject} position={target} />
      {beam && (
        <mesh
          ref={meshRef}
          geometry={geometry}
          material={material}
          frustumCulled={false}
          renderOrder={-20}
          onBeforeRender={onBeforeRender as unknown as Mesh["onBeforeRender"]}
        />
      )}
      {dustPoints && (
        <points
          geometry={dustPoints.geometry}
          material={dustPoints.material}
          frustumCulled={false}
          renderOrder={-19}
          onBeforeRender={onDustBeforeRender as unknown as Points["onBeforeRender"]}
        />
      )}
    </>
  );
}
