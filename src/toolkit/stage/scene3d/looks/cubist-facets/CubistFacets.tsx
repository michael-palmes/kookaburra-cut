import { useLayoutEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute, type IUniform, Vector3 } from "three";
import {
  lookColorUniform,
  loopSeconds,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { type CubistRelief, cubistBreath, cubistRelief } from "./relief";
import { CUBIST_LINE_HALF_WIDTH, RELIEF_FRAGMENT, RELIEF_VERTEX, SKY_FRAGMENT } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const TAU = Math.PI * 2;
const BREATH_PERIOD = 30;
/** The light's height over its turning circle (the sketch's 0.25 before normalising). */
const LIGHT_LIFT = 0.25;

/** The relief as one merged geometry; rebuilt only when a layout param changes. */
function reliefGeometry(r: CubistRelief): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(r.position, 3));
  g.setAttribute("aHalf", new Float32BufferAttribute(r.half, 3));
  g.setAttribute("aCell", new Float32BufferAttribute(r.cell, 3));
  g.setAttribute("aBary", new Float32BufferAttribute(r.bary, 3));
  g.setAttribute("aEdge", new Float32BufferAttribute(r.edge, 3));
  g.setAttribute("aMod", new Float32BufferAttribute(r.mod, 2));
  g.setAttribute("aSeed", new Float32BufferAttribute(r.seed, 3));
  return g;
}

/** Cubist facets: a composed relief wall of folded planes in three courses round the stage, like a Braque scaffold. A virtual light turns round the ring, so each folded half steps through four close tones; cells breathe in and out; an eye-level haze closes the tones up where the headline sits. Unlit, on the absolute look clock. */
export function CubistFacets({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const dome = useSkyDomeGeometry();
  const planes = Math.round(params.planes);
  const relief = useMemo(
    () => cubistRelief({ radius: params.radius, planes, fold: params.fold, relief: params.relief }),
    [params.radius, planes, params.fold, params.relief],
  );
  const geometry = useMemo(() => reliefGeometry(relief), [relief]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const breath = cubistBreath(params.relief);

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uOchre: lookColorUniform("#000000"),
      uUmber: lookColorUniform("#000000"),
      uGrey: lookColorUniform("#000000"),
      uPale: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
      uHaze: { value: 0.7 },
    };
    return {
      relief: {
        key: "cubist-facets/relief",
        vertexShader: RELIEF_VERTEX,
        fragmentShader: RELIEF_FRAGMENT,
        transparent: true,
        depthWrite: true,
        uniforms: {
          ...shared,
          uLight: { value: new Vector3(1, 0, 0) },
          uBreath: { value: 0 },
          uBreathPhase: { value: 0 },
          uPassage: { value: 0.35 },
          uLineHalf: { value: CUBIST_LINE_HALF_WIDTH },
        },
      },
      sky: skyDomeMaterial({
        key: "cubist-facets/sky",
        fragmentShader: SKY_FRAGMENT,
        uniforms: { ...shared, uRadius: { value: 22 } },
      }),
    };
  }, []);

  const [ochre, umber, grey, pale] = colors;
  useLayoutEffect(() => {
    const u = mats.relief.uniforms;
    u.uOchre.value.set(ochre);
    u.uUmber.value.set(umber);
    u.uGrey.value.set(grey);
    u.uPale.value.set(pale);
    u.uBacking.value.set(backing);
  }, [mats, ochre, umber, grey, pale, backing]);

  useLayoutEffect(() => {
    const u = mats.relief.uniforms;
    const a = (TAU * loopSeconds(t, params.lightPeriod)) / params.lightPeriod;
    u.uLight.value.set(Math.cos(a), LIGHT_LIFT, Math.sin(a)).normalize();
    u.uBreathPhase.value = (TAU * loopSeconds(t, BREATH_PERIOD)) / BREATH_PERIOD;
    u.uBreath.value = breath;
    u.uPassage.value = params.passage;
    u.uHaze.value = params.haze;
    mats.sky.uniforms.uRadius.value = params.radius;
  }, [mats, t, breath, params.lightPeriod, params.passage, params.haze, params.radius]);

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={dome} material={mats.sky} />
      <mesh geometry={geometry} material={mats.relief} frustumCulled={false} />
    </group>
  );
}
