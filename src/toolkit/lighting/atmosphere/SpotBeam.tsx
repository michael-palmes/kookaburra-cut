import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type Camera,
  Color,
  type DataTexture,
  type Matrix4,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Points,
  type Scene,
  type ShaderMaterial,
  type SpotLight,
  type Texture,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from "three";
import { CAMERA } from "../../../engine/format";
import { orbitToView } from "../../../engine/orbit";
import { useSceneDoc } from "../../../engine/sceneDoc";
import type { SceneDoc } from "../../../engine/sceneDocSchema";
import { spotHalfAngleRad } from "../../../engine/sceneLighting";
import { useTimeline } from "../../../engine/timeline";
import type { LightSpec, LightVolumetricSpec } from "../../../theme/tokens";
import { useStageFloorY } from "../../stage/context";
import { createBeamDust, createBeamMaterial } from "./beamParts";
import { createGrateTexture, type GrateSpec } from "./grate";
import { BEAM_DUST_DEFAULTS, BEAM_SMOKE_DEFAULTS } from "./VolumetricSpot";

/** A sidecar spot's visible beam (`volumetric`): the research VolumetricSpot's haze, smoke and dust on the stage's own spot light, read live on every draw so keys, light spaces and the shadow budget all reach the shafts. */

type Vec3 = [number, number, number];

const HAZE = { density: 0.08, anisotropy: 0.65, strength: 1, heightFalloff: 0, groundFade: 1.5 };
const GRATE: Omit<GrateSpec, "lens"> = {
  offset: 0.3,
  along: [0.15, 7],
  width: 10,
  slat: [0.01, 0.1],
  gap: [0.01, 0.06],
  seed: 42,
  soft: 0.012,
};
const REACH = 40;
const NO_FLOOR = -1e6;
const FLOOR_LIFT = 0.004;
const SMOKE_MEAN = 0.45;
const EVOLVE_DIR = new Vector3(0.31, -0.57, 0.76).normalize();
const WARP_DIR = new Vector3(-0.62, 0.21, 0.75).normalize();
const LIGHT_COLOR = new Color();

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finite3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);

function earliest<T extends { tMs: number }>(
  keys: readonly T[] | undefined,
  ok: (k: T) => boolean,
) {
  return (keys ?? [])
    .filter(ok)
    .reduce<T | undefined>((a, k) => (a && a.tMs <= k.tMs ? a : k), undefined);
}

/** Where `lens: "camera"` points: the scene's opening camera, so the bars stay a pure function of the sidecar. */
export function openingLens(doc: SceneDoc | null | undefined): Vec3 {
  if (doc?.cameraMode === "rig") {
    const key = earliest(doc.cameraRig?.keys, (k) => finite3(k.pose?.position));
    if (key) return [key.pose.position[0], key.pose.position[1], key.pose.position[2]];
  }
  const orbit = earliest(
    doc?.camera?.keys,
    (k) =>
      finite3(k.pose?.target) &&
      finite(k.pose.azimuthDeg) &&
      finite(k.pose.elevationDeg) &&
      finite(k.pose.distance),
  );
  if (orbit) return orbitToView(orbit.pose).position;
  return [CAMERA.position[0], CAMERA.position[1], CAMERA.position[2]];
}

/** The spot's grate cookie, baked from its resting world pose and owned here, so an edit disposes the old one; null without a grate. */
export function useSpotGrate(spec: LightSpec, position: Vec3, aim: Vec3): DataTexture | null {
  const doc = useSceneDoc();
  const grate = spec.type === "spot" ? spec.volumetric?.grate : undefined;
  const key =
    grate && spec.type === "spot" && (spec.space ?? "world") === "world"
      ? JSON.stringify([
          { ...GRATE, ...grate, lens: Array.isArray(grate.lens) ? grate.lens : openingLens(doc) },
          position,
          aim,
          spec.angleDeg,
        ])
      : "";
  const texture = useMemo(() => {
    if (!key) return null;
    const [g, p, t, a] = JSON.parse(key) as [GrateSpec, Vec3, Vec3, number];
    return createGrateTexture(g, { position: p, target: t, halfAngle: spotHalfAngleRad(a) });
  }, [key]);
  useLayoutEffect(() => () => texture?.dispose(), [texture]);
  return texture;
}

const UP = new Vector3();
const U = new Vector3();
const V = new Vector3();
const END = new Vector3();
const RIM = new Vector3();

/** World bounds of the cone, clipped above the floor. Runs on every beam draw, so it reuses scratch vectors. */
function coneBox(
  apex: Vector3,
  axis: Vector3,
  halfAngle: number,
  reach: number,
  floorY: number,
  min: Vector3,
  max: Vector3,
) {
  UP.set(Math.abs(axis.y) > 0.95 ? 1 : 0, Math.abs(axis.y) > 0.95 ? 0 : 1, 0);
  U.crossVectors(axis, UP).normalize();
  V.crossVectors(axis, U).normalize();
  const r = Math.tan(halfAngle) * reach;
  END.copy(apex).addScaledVector(axis, reach);
  min.copy(apex);
  max.copy(apex);
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    RIM.copy(END)
      .addScaledVector(U, Math.cos(a) * r)
      .addScaledVector(V, Math.sin(a) * r);
    min.min(RIM);
    max.max(RIM);
  }
  min.y = Math.max(min.y, floorY + FLOOR_LIFT);
  max.y = Math.max(max.y, min.y + 0.1);
}

export function SpotBeam({
  light,
  target,
  spec,
  rest,
}: {
  light: RefObject<Object3D | null>;
  target: Object3D;
  spec: LightVolumetricSpec;
  /** Where the light rests, for the dust when neither it nor the haze has a box. */
  rest: { position: Vec3; aim: Vec3; angleDeg: number };
}) {
  const floorY = useStageFloorY() ?? NO_FLOOR;
  const seconds = useTimeline().localMs / 1000;
  const haze = { ...HAZE, ...spec.haze };
  const smoke = spec.smoke ? { ...BEAM_SMOKE_DEFAULTS, ...spec.smoke } : null;
  const box = spec.box;
  const restKey = JSON.stringify([rest, floorY]);
  const dustBox = useMemo(() => {
    if (box) return box;
    const [r, f] = JSON.parse(restKey) as [typeof rest, number];
    const apex = new Vector3(...r.position);
    const axis = new Vector3(...r.aim).sub(apex).normalize();
    const min = new Vector3();
    const max = new Vector3();
    coneBox(apex, axis, spotHalfAngleRad(r.angleDeg), REACH, f, min, max);
    return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 };
  }, [box, restKey]);
  const dust = spec.dust ? { ...BEAM_DUST_DEFAULTS, ...dustBox, ...spec.dust } : null;
  const extinction = spec.extinction === true;
  const hasBox = box !== undefined;
  const hasSmoke = smoke !== null;
  const ground = haze.groundFade > 0 && floorY > NO_FLOOR;
  const meshRef = useRef<Mesh>(null);

  const material = useMemo(
    () => createBeamMaterial({ box: hasBox, smoke: hasSmoke, extinction, ground }),
    [hasBox, hasSmoke, extinction, ground],
  );
  useLayoutEffect(() => () => material.dispose(), [material]);
  const geometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const dustCount = dust?.count ?? 0;
  const dustSeed = dust?.seed ?? 0;
  const motes = useMemo(
    () => (dustCount > 0 ? createBeamDust(dustCount, dustSeed) : null),
    [dustCount, dustSeed],
  );
  useLayoutEffect(
    () => () => {
      motes?.geometry.dispose();
      motes?.material.dispose();
    },
    [motes],
  );

  // The clock-driven values, once per render.
  useLayoutEffect(() => {
    const u = material.uniforms;
    u.uDensity.value = haze.density;
    u.uG.value = haze.anisotropy;
    u.uFloorY.value = floorY;
    u.uHeightFalloff.value = haze.heightFalloff;
    u.uNoiseAmount.value = 0;
    u.uHotspot.value = 0;
    if (box) {
      (u.uBoxMin.value as Vector3).set(...box.min);
      (u.uBoxMax.value as Vector3).set(...box.max);
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
    u.uGroundFade.value = ground ? haze.groundFade : 1;
    u.uMeanDensity.value =
      haze.density * (smoke ? smoke.floor + (1 - smoke.floor) * SMOKE_MEAN : 1);
    if (dust && motes) {
      const d = motes.material.uniforms;
      (d.uMin.value as Vector3).set(...dust.min);
      (d.uMax.value as Vector3).set(...dust.max);
      (d.uShift.value as Vector3).set(...dust.drift).multiplyScalar(seconds);
      (d.uWander.value as Vector3).copy(WARP_DIR).multiplyScalar(dust.jitterSpeed * seconds);
      d.uJitter.value = dust.jitter;
      d.uJitterScale.value = dust.jitterScale;
      (d.uRadius.value as Vector2).set(dust.radius[0], dust.radius[1]);
      d.uG.value = dust.forward;
    }
  });

  // The light's own values, per draw: keyframes and relative spaces write them straight onto it.
  const syncLight = useMemo(() => {
    const aim = new Vector3();
    return (u: ShaderMaterial["uniforms"]): SpotLight | null => {
      const spot = light.current as SpotLight | null;
      if (!spot?.isSpotLight) return null;
      const apex = u.uApex.value as Vector3;
      spot.getWorldPosition(apex);
      target.getWorldPosition(aim);
      (u.uAxis.value as Vector3).copy(aim.sub(apex).normalize());
      u.uCosOuter.value = Math.cos(spot.angle);
      u.uCosInner.value = Math.cos(spot.angle * (1 - spot.penumbra));
      u.uDecay.value = spot.decay;
      spot.shadow.updateMatrices(spot);
      (u.uLightMatrix.value as Matrix4).copy(spot.shadow.matrix);
      const shadowMap = spot.castShadow ? spot.shadow.map : null;
      u.uShadowMap.value = shadowMap ? shadowMap.texture : null;
      u.uShadowOn.value = shadowMap ? 1 : 0;
      u.uShadowBias.value = spot.shadow.bias;
      const map = (spot as SpotLight & { map: Texture | null }).map;
      u.uGobo.value = map;
      u.uGoboOn.value = map ? 1 : 0;
      return spot;
    };
  }, [light, target]);

  // The proxy follows the light too: the cone's bounds, cut to the haze box.
  const onBeamDraw = useMemo(() => {
    const min = new Vector3();
    const max = new Vector3();
    const lo = new Vector3();
    const hi = new Vector3();
    return () => {
      const mesh = meshRef.current;
      const u = material.uniforms;
      const spot = syncLight(u);
      if (!spot || !mesh) return;
      u.uRange.value = spot.distance;
      (u.uRadiance.value as Color).copy(spot.color).multiplyScalar(spot.intensity * haze.strength);
      const reach = spot.distance > 0 ? spot.distance : REACH;
      coneBox(u.uApex.value, u.uAxis.value, spot.angle, reach, floorY, min, max);
      if (box) {
        lo.set(...box.min);
        hi.set(...box.max);
        min.max(lo);
        max.min(hi);
        if (max.x <= min.x || max.y <= min.y || max.z <= min.z) {
          min.copy(lo);
          max.copy(hi);
        }
      }
      mesh.matrixWorld
        .makeScale(max.x - min.x, max.y - min.y, max.z - min.z)
        .setPosition((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    };
  }, [material, syncLight, haze.strength, floorY, box]);

  const dustColor = dust?.color ?? "#ffffff";
  const dustGain = dust?.gain ?? 1;
  const onDustDraw = useMemo(() => {
    const size = new Vector2();
    return (renderer: WebGLRenderer, _scene: Scene, camera: Camera) => {
      if (!motes) return;
      const u = motes.material.uniforms;
      const spot = syncLight(u);
      if (!spot) return;
      (u.uColor.value as Color)
        .set(dustColor)
        .multiply(LIGHT_COLOR.copy(spot.color))
        .multiplyScalar(spot.intensity * dustGain);
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const fov = ((camera as PerspectiveCamera).fov ?? 45) * (Math.PI / 180);
      u.uPxPerUnit.value = size.y / (2 * Math.tan(fov / 2));
    };
  }, [motes, syncLight, dustColor, dustGain]);

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        frustumCulled={false}
        renderOrder={-20}
        onBeforeRender={onBeamDraw as unknown as Mesh["onBeforeRender"]}
      />
      {motes && (
        <points
          geometry={motes.geometry}
          material={motes.material}
          frustumCulled={false}
          renderOrder={-19}
          onBeforeRender={onDustDraw as unknown as Points["onBeforeRender"]}
        />
      )}
    </>
  );
}
