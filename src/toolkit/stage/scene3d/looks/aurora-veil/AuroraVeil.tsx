import { useLayoutEffect, useMemo } from "react";
import { AdditiveBlending, DoubleSide, NormalBlending } from "three";
import {
  lookColorUniform,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  AURORA,
  auroraAdditive,
  auroraAlpha,
  auroraCurtainGeometry,
  auroraCurtainIndices,
  auroraCurtains,
} from "./curtains";
import { CURTAIN_FRAGMENT, CURTAIN_VERTEX, DOME_FRAGMENT } from "./shaders";

/** Far shell for the tint dome: the curtains (r up to about 66) stand well inside it, and it barely parallaxes. */
const DOME_RADIUS = 300;

/** Aurora veil: folded ribbon curtains on a far ring over a zenith tint dome (F7). One strip mesh holds every curtain (one draw call), folded and rippled in the vertex stage on harmonics of a 240 s loop. Additive over a dark backing, normal blending (pastel veils) over a light one. */
export function AuroraVeil({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const dome = useSkyDomeGeometry(DOME_RADIUS);
  const curtains = useMemo(() => auroraCurtainGeometry(auroraCurtains()), []);
  useLayoutEffect(() => () => curtains.dispose(), [curtains]);

  const mats = useLookMaterials(
    () => ({
      dome: skyDomeMaterial({
        key: "aurora-veil/dome",
        fragmentShader: DOME_FRAGMENT,
        uniforms: {
          uSky: lookColorUniform("#000000"),
          uHem: lookColorUniform("#000000"),
          uBacking: lookColorUniform("#000000"),
          uAmt: { value: 1 },
          uGlow: { value: 0.07 },
        },
      }),
      curtain: {
        key: "aurora-veil/curtain",
        vertexShader: CURTAIN_VERTEX,
        fragmentShader: CURTAIN_FRAGMENT,
        transparent: true,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uCount: { value: AURORA.maxCurtains },
          uRadius: { value: 46 },
          uHem: { value: 3.6 },
          uFold: { value: 5.5 },
          uRays: { value: 1 },
          uAlpha: { value: 0.75 },
          uHemColor: lookColorUniform("#000000"),
          uCrown: lookColorUniform("#000000"),
        },
      },
    }),
    [],
  );

  const additive = useMemo(() => auroraAdditive(backing), [backing]);
  useLayoutEffect(() => {
    const d = mats.dome.uniforms;
    d.uHem.value.set(colors[0]);
    d.uSky.value.set(colors[2]);
    d.uBacking.value.set(backing);
    d.uAmt.value = additive ? 1 : 0.7;
    d.uGlow.value = additive ? 0.07 : 0.06;
    const c = mats.curtain.uniforms;
    c.uHemColor.value.set(colors[0]);
    c.uCrown.value.set(colors[1]);
    mats.curtain.blending = additive ? AdditiveBlending : NormalBlending;
  }, [mats, colors[0], colors[1], colors[2], backing, additive]);

  const count = Math.round(params.curtains);
  useLayoutEffect(() => {
    curtains.setDrawRange(0, count * auroraCurtainIndices());
  }, [curtains, count]);

  useLayoutEffect(() => {
    const c = mats.curtain.uniforms;
    c.uTime.value = loopSeconds(t, AURORA.period);
    c.uCount.value = count;
    c.uRadius.value = params.radius;
    c.uHem.value = params.hemHeight;
    c.uFold.value = params.fold;
    c.uRays.value = params.rays;
    c.uAlpha.value = auroraAlpha(params.brightness, additive);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={dome} material={mats.dome} />
      <mesh geometry={curtains} material={mats.curtain} frustumCulled={false} />
    </group>
  );
}
