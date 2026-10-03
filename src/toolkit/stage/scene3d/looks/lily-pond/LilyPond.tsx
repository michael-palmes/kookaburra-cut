import { useLayoutEffect, useMemo } from "react";
import { CircleGeometry, type IUniform, Sphere, Vector2, Vector3 } from "three";
import {
  brushMaskUniforms,
  lookColorUniform,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
  useSplatBoilStep,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  lilyPadGeometry,
  placeLilyPads,
  RAFT_LOOP,
  RIPPLE_LOOP,
  WATER_RADIUS,
  WATER_Y,
} from "./rafts";
import {
  BLOOM_FRAGMENT,
  BLOOM_VERTEX,
  CLOUD_SCALE,
  DOME_FRAGMENT,
  PAD_FRAGMENT,
  PAD_VERTEX,
  WATER_FRAGMENT,
} from "./shaders";

/** Lily pond: Monet's horizonless water. A hazy dome over still water laid with broken-colour reflection strokes, scheduled ripple rings and gliding cloud reflections, with rafts of pads drifting round their own eddies. Every part after the opaque dome is transparent with depth writes off and a stage-centred bounding sphere, so mount order is draw order. */

/** Stroke boil rate (steps per second). */
const BOIL_FPS = 2;
/** Cloud reflection drift in world units per second (about 0.7, mostly along x). */
const CLOUD_DRIFT = { x: 0.66, z: 0.26 } as const;
/** The dome encloses the water disc (the sketch's 150). */
const DOME_RADIUS = 150;

function waterGeometry(): CircleGeometry {
  const g = new CircleGeometry(WATER_RADIUS, 160);
  g.rotateX(-Math.PI / 2);
  g.translate(0, WATER_Y, 0);
  g.boundingSphere = new Sphere(new Vector3(), WATER_RADIUS);
  return g;
}

export function LilyPond({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const step = useSplatBoilStep(BOIL_FPS);
  const dome = useSkyDomeGeometry(DOME_RADIUS);
  const water = useMemo(waterGeometry, []);
  const { pads } = useMemo(() => placeLilyPads(params.clearRadius), [params.clearRadius]);
  const padGeometry = useMemo(() => lilyPadGeometry(pads), [pads]);
  useLayoutEffect(() => () => water.dispose(), [water]);
  useLayoutEffect(() => () => padGeometry.dispose(), [padGeometry]);

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uDeep: lookColorUniform("#000000"),
      uSky: lookColorUniform("#000000"),
      uPad: lookColorUniform("#000000"),
      uBloom: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
      uRaftT: { value: 0 },
    };
    const layer = { transparent: true, depthWrite: false };
    return {
      dome: skyDomeMaterial({
        key: "lily-pond/dome",
        fragmentShader: DOME_FRAGMENT,
        uniforms: shared,
      }),
      water: {
        key: "lily-pond/water",
        fragmentShader: WATER_FRAGMENT,
        ...layer,
        uniforms: {
          ...shared,
          ...brushMaskUniforms(),
          uRippleT: { value: 0 },
          uRipples: { value: 6 },
          uStep: { value: 0 },
          uCloud: { value: new Vector2() },
          uClear: { value: 7 },
          uStroke: { value: 1 },
        },
      },
      pad: {
        key: "lily-pond/pad",
        vertexShader: PAD_VERTEX,
        fragmentShader: PAD_FRAGMENT,
        ...layer,
        uniforms: { ...shared, ...brushMaskUniforms() },
      },
      bloom: {
        key: "lily-pond/bloom",
        vertexShader: BLOOM_VERTEX,
        fragmentShader: BLOOM_FRAGMENT,
        ...layer,
        uniforms: { ...shared, uBlossoms: { value: 0.12 } },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.water.uniforms;
    u.uDeep.value.set(colors[0]);
    u.uSky.value.set(colors[1]);
    u.uPad.value.set(colors[2]);
    u.uBloom.value.set(colors[3]);
    u.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], colors[3], backing]);

  const count = Math.min(pads.length, Math.max(0, Math.round(params.padCount)));
  useLayoutEffect(() => {
    const u = mats.water.uniforms;
    u.uRaftT.value = loopSeconds(t * params.drift, RAFT_LOOP);
    u.uRippleT.value = loopSeconds(t, RIPPLE_LOOP);
    u.uRipples.value = Math.round(params.ripples);
    u.uStep.value = step;
    u.uCloud.value.set(t * CLOUD_DRIFT.x * CLOUD_SCALE, t * CLOUD_DRIFT.z * CLOUD_SCALE);
    u.uClear.value = params.clearRadius;
    u.uStroke.value = params.strokeScale;
    mats.bloom.uniforms.uBlossoms.value = params.blossoms;
    padGeometry.instanceCount = count;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={dome} material={mats.dome} frustumCulled={false} />
      <mesh geometry={water} material={mats.water} frustumCulled={false} />
      <mesh geometry={padGeometry} material={mats.pad} frustumCulled={false} visible={count > 0} />
      <mesh
        geometry={padGeometry}
        material={mats.bloom}
        frustumCulled={false}
        visible={count > 0 && params.blossoms > 0}
      />
    </group>
  );
}
