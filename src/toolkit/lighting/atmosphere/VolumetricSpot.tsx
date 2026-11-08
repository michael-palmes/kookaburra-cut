import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  Matrix4,
  type Mesh,
  Object3D,
  ShaderMaterial,
  type SpotLight,
  Vector3,
} from "three";
import { useTimeline } from "../../../engine/timeline";
import { BEAM_FRAGMENT, BEAM_VERTEX } from "./beamShader";
import { GOBO_DEFAULTS, type GoboSpec, goboTexture } from "./gobo";

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
}

export const BEAM_HAZE_DEFAULTS: BeamHaze = {
  density: 0.35,
  anisotropy: 0.55,
  noise: 0.6,
  noiseScale: 0.55,
  drift: [0.05, 0.02, 0.03],
  heightFalloff: 0,
  strength: 1,
};

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
  } = props;
  const haze = { ...BEAM_HAZE_DEFAULTS, ...props.haze };
  const gobo = props.gobo === null ? null : { ...GOBO_DEFAULTS, ...props.gobo };
  const goboKey = gobo ? JSON.stringify(gobo) : "";
  const time = useTimeline();
  const lightRef = useRef<SpotLight>(null);
  const meshRef = useRef<Mesh>(null);
  const targetObject = useMemo(() => new Object3D(), []);
  const halfAngle = (angleDeg * Math.PI) / 360;

  const map = useMemo(() => (goboKey ? goboTexture(JSON.parse(goboKey)) : null), [goboKey]);

  const poseKey = `${position.join(",")}|${target.join(",")}`;
  const geometry = useMemo(() => {
    const [p, t] = poseKey.split("|").map((s) => s.split(",").map(Number));
    const apex = new Vector3(p[0], p[1], p[2]);
    const axis = new Vector3(t[0], t[1], t[2]).sub(apex).normalize();
    const { min, max } = coneBox(apex, axis, halfAngle, distance > 0 ? distance : reach, floorY);
    const box = new BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
    box.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    return box;
  }, [poseKey, halfAngle, distance, reach, floorY]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: "kookaburra-volumetric-spot",
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: BackSide,
        blending: AdditiveBlending,
        uniforms: {
          uApex: { value: new Vector3() },
          uAxis: { value: new Vector3(0, -1, 0) },
          uCosOuter: { value: 0.9 },
          uCosInner: { value: 0.95 },
          uRange: { value: 0 },
          uDecay: { value: 1.2 },
          uSoftRadius: { value: 0.6 },
          uRadiance: { value: new Color() },
          uDensity: { value: 0.3 },
          uG: { value: 0.5 },
          uFloorY: { value: -1.5 },
          uHeightFalloff: { value: 0 },
          uDrift: { value: new Vector3() },
          uNoiseScale: { value: 0.5 },
          uNoiseAmount: { value: 0.5 },
          uGobo: { value: null },
          uGoboOn: { value: 0 },
          uLightMatrix: { value: new Matrix4() },
          uShadowMap: { value: null },
          uShadowOn: { value: 0 },
          uShadowBias: { value: 0 },
        },
      }),
    [],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);

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
  });

  // Per draw: the light's world pose and shadow matrix are only final once the renderer has updated them for this render.
  const onBeforeRender = useMemo(() => {
    const aim = new Vector3();
    return () => {
      const light = lightRef.current;
      const u = material.uniforms;
      const apex = u.uApex.value as Vector3;
      if (!light) return;
      light.getWorldPosition(apex);
      targetObject.getWorldPosition(aim);
      (u.uAxis.value as Vector3).copy(aim.sub(apex).normalize());
      light.shadow.updateMatrices(light);
      (u.uLightMatrix.value as Matrix4).copy(light.shadow.matrix);
      const shadowMap = light.castShadow ? light.shadow.map : null;
      u.uShadowMap.value = shadowMap ? shadowMap.texture : null;
      u.uShadowOn.value = shadowMap ? 1 : 0;
    };
  }, [material, targetObject]);

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
          onBeforeRender={onBeforeRender}
        />
      )}
    </>
  );
}
