import { useLayoutEffect, useMemo } from "react";
import {
  BackSide,
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Sphere,
  SphereGeometry,
  Vector3,
} from "three";
import {
  brushMaskUniforms,
  lookColorUniform,
  STROKE_SPLAT_MATERIAL,
  useLookMaterials,
  useLookTime,
  useSplatBoilStep,
  useStrokeSplatGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { DAUB_FIELD, placeDaubs, RIDGE_RADIUS } from "./paddock";
import {
  DAUB_FRAGMENT,
  DAUB_VERTEX,
  GROUND_FRAGMENT,
  LOCAL_VERTEX,
  RIDGE_FRAGMENT,
  SKY_FRAGMENT,
} from "./shaders";

/** Blue and gold: Heidelberg School paddocks. A daub field of gold and straw brush strokes (F3 stroke splats) over a warm underpainted ground, one soft blue ridge at the horizon and a warm haze glow above it. Every part is transparent with depth writes off and a stage-centred bounding sphere, so the sort ties and the mount order (sky, ground, ridge, daubs) is the draw order. */

const SKY_RADIUS = 150;
const RIDGE_SPAN = { bottom: -2, top: 16 } as const;
/** Ground and ridge share their rim vertices, so the ground ends exactly at the ridge foot. */
const RIM_SEGMENTS = 256;

const centred = <T extends BufferGeometry>(geometry: T, radius: number): T => {
  geometry.boundingSphere = new Sphere(new Vector3(), radius);
  return geometry;
};

function createParts() {
  const sky = centred(new SphereGeometry(SKY_RADIUS, 48, 24), SKY_RADIUS);
  const ground = new CircleGeometry(RIDGE_RADIUS, RIM_SEGMENTS);
  ground.rotateX(-Math.PI / 2);
  ground.translate(0, -2, 0);
  const height = RIDGE_SPAN.top - RIDGE_SPAN.bottom;
  const ridge = new CylinderGeometry(RIDGE_RADIUS, RIDGE_RADIUS, height, RIM_SEGMENTS, 1, true);
  ridge.translate(0, RIDGE_SPAN.bottom + height / 2, 0);
  return {
    sky,
    ground: centred(ground, RIDGE_RADIUS),
    ridge: centred(ridge, Math.hypot(RIDGE_RADIUS, RIDGE_SPAN.top)),
  };
}

export function BlueAndGold({ colors, params, speed }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const boilStep = useSplatBoilStep(params.boilFps);
  const [gold, straw, shade, ridge] = colors;

  const parts = useMemo(createParts, []);
  useLayoutEffect(
    () => () => {
      for (const g of Object.values(parts)) g.dispose();
    },
    [parts],
  );
  const daubs = useMemo(placeDaubs, []);
  const daubGeometry = useStrokeSplatGeometry(daubs);

  const mats = useLookMaterials(() => {
    const palette = () => ({
      uGold: lookColorUniform(gold),
      uStraw: lookColorUniform(straw),
      uShade: lookColorUniform(shade),
      uRidge: lookColorUniform(ridge),
    });
    return {
      sky: {
        key: "blue-and-gold/sky",
        vertexShader: LOCAL_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        transparent: true,
        side: BackSide,
        uniforms: palette(),
      },
      ground: {
        key: "blue-and-gold/ground",
        vertexShader: LOCAL_VERTEX,
        fragmentShader: GROUND_FRAGMENT,
        transparent: true,
        uniforms: {
          ...palette(),
          uTime: { value: 0 },
          uCloud: { value: 0 },
          uClear: { value: DAUB_FIELD.inner },
          uCalm: { value: 0 },
        },
      },
      ridge: {
        key: "blue-and-gold/ridge",
        vertexShader: LOCAL_VERTEX,
        fragmentShader: RIDGE_FRAGMENT,
        transparent: true,
        side: BackSide,
        uniforms: { ...palette(), uRidgeHeight: { value: 1 }, uCalm: { value: 0 } },
      },
      daubs: {
        key: "blue-and-gold/daubs",
        vertexShader: DAUB_VERTEX,
        fragmentShader: DAUB_FRAGMENT,
        ...STROKE_SPLAT_MATERIAL,
        uniforms: {
          ...palette(),
          ...brushMaskUniforms(),
          uTime: { value: 0 },
          uWind: { value: 1 },
          uCloud: { value: 0 },
          uClear: { value: DAUB_FIELD.inner },
          uCalm: { value: 0 },
          uKeep: { value: 1 },
          uSize: { value: 1 },
          uBoil: { value: 0 },
          uBoilStep: { value: 0 },
        },
      },
    };
  }, [gold, straw, shade, ridge]);

  useLayoutEffect(() => {
    const { ground, ridge: ridgeMat, daubs: daubMat } = mats;
    ground.uniforms.uTime.value = t;
    ground.uniforms.uCloud.value = params.cloudShadow;
    ground.uniforms.uClear.value = params.clearRadius;
    ground.uniforms.uCalm.value = params.textCalm;
    ridgeMat.uniforms.uRidgeHeight.value = params.ridgeHeight;
    ridgeMat.uniforms.uCalm.value = params.textCalm;
    const u = daubMat.uniforms;
    u.uTime.value = t;
    u.uWind.value = params.wind;
    u.uCloud.value = params.cloudShadow;
    u.uClear.value = params.clearRadius;
    u.uCalm.value = params.textCalm;
    u.uKeep.value = params.density / DAUB_FIELD.maxDensity;
    u.uSize.value = params.daubSize;
    u.uBoil.value = Math.round(params.boilFps) > 0 ? 1 : 0;
    u.uBoilStep.value = boilStep;
  }, [mats, t, boilStep, params]);

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={parts.sky} material={mats.sky} frustumCulled={false} />
      <mesh geometry={parts.ground} material={mats.ground} frustumCulled={false} />
      <mesh geometry={parts.ridge} material={mats.ridge} frustumCulled={false} />
      <mesh geometry={daubGeometry} material={mats.daubs} frustumCulled={false} />
    </group>
  );
}
