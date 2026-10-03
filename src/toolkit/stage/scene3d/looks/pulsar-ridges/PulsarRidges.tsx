import { useLayoutEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  type Vector3,
} from "three";
import {
  inkRasterSync,
  inkRibbonMaterial,
  inkStrands,
  lookColorUniform,
  loopSeconds,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  CREST_FRAGMENT,
  CREST_PATH,
  CREST_VERTEX_HOOK,
  PULSAR,
  SKIRT_FRAGMENT,
  SKIRT_VERTEX,
} from "./shaders";

const TAU = Math.PI * 2;
const { maxRings: RINGS, segments: SEG } = PULSAR;

/** One strip per ring, inner first: bottom row on the floor, top row on the crest (moved in the vertex stage). */
function skirtGeometry(): BufferGeometry {
  const pos = new Float32Array(RINGS * (SEG + 1) * 2 * 3);
  const idx = new Uint32Array(RINGS * SEG * 6);
  let p = 0;
  let o = 0;
  for (let k = 0; k < RINGS; k++) {
    const base = k * (SEG + 1) * 2;
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * TAU;
      pos.set([th, k, 0, th, k, 1], p);
      p += 6;
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], o);
      o += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

/** Pulsar ridges: concentric closed ridgelines on the floor (CP 1919 as a landscape). Opaque-depth skirts hide far ridges behind near ones; crests are F2 ink ribbons. Massifs slide round once per 240 s, ring peaks ripple sideways on a 60 s harmonic cycle, envelopes breathe on 20 to 60 s periods. */
export function PulsarRidges({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const shared = useMemo(
    () => ({
      uTime: { value: 0 },
      uRings: { value: 34 },
      uValley: { value: 12 },
      uHeight: { value: 1 },
      uMassifs: { value: 4 },
    }),
    [],
  );
  const mats = useLookMaterials(
    () => ({
      skirt: {
        key: "pulsar-ridges/skirt",
        vertexShader: SKIRT_VERTEX,
        fragmentShader: SKIRT_FRAGMENT,
        uniforms: {
          ...shared,
          uSkirt: lookColorUniform("#141a24"),
          uBacking: lookColorUniform("#0d1219"),
        },
        side: DoubleSide,
      },
      crest: inkRibbonMaterial({
        key: "pulsar-ridges/crest",
        path: CREST_PATH,
        vertex: CREST_VERTEX_HOOK,
        fragmentShader: CREST_FRAGMENT,
        uniforms: {
          ...shared,
          uRidge: lookColorUniform("#3b4759"),
          uCrest: lookColorUniform("#525f77"),
        },
        lineWidth: { px: 2.2 },
        fade: [45, 90],
        lift: 0.003,
      }),
    }),
    [shared],
  );
  const skirts = useMemo(skirtGeometry, []);
  useLayoutEffect(() => () => skirts.dispose(), [skirts]);
  const crests = useInkRibbonGeometry(
    () => inkStrands(RINGS, SEG, (s, i) => [(i / SEG) * TAU, s], { closed: true }),
    [],
  );

  const rings = Math.round(params.rings);
  useLayoutEffect(() => {
    shared.uTime.value = loopSeconds(t * params.drift, PULSAR.period);
    shared.uRings.value = rings;
    shared.uValley.value = params.valley;
    shared.uHeight.value = params.height;
    shared.uMassifs.value = Math.round(params.massifs);
    mats.skirt.uniforms.uSkirt.value.set(colors[2]);
    mats.skirt.uniforms.uBacking.value.set(backing);
    mats.crest.uniforms.uRidge.value.set(colors[0]);
    mats.crest.uniforms.uCrest.value.set(colors[1]);
    (mats.crest.uniforms.uInkWidth.value as Vector3).y = params.lineWidth;
    skirts.setDrawRange(0, rings * SEG * 6);
    showInkStrands(crests, rings);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={skirts} material={mats.skirt} frustumCulled={false} />
      <mesh
        geometry={crests}
        material={mats.crest}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
