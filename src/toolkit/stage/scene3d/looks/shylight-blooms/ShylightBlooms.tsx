import { useLayoutEffect, useMemo } from "react";
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  RingGeometry,
  Vector3,
  Vector4,
} from "three";
import { useFormat } from "../../../../../engine/format";
import {
  inkLoop,
  inkPolyline,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  seededPlacements,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  BLOOMS,
  bloomAnchors,
  bloomPortrait,
  flutterPhase,
  PETALS_PER_BLOOM,
  writeBloomPoses,
} from "./blooms";
import {
  CABLE_FRAGMENT,
  CABLE_PATH,
  CABLE_VERTEX_HOOK,
  CORE_FRAGMENT,
  CORE_VERTEX,
  PETAL_FRAGMENT,
  PETAL_VERTEX,
  POOL_FRAGMENT,
} from "./shaders";

const TAU = Math.PI * 2;
const SEG_L = 10;
const SEG_W = 4;
const RIG_POINTS = 96;

/** Instanced petal strips, bloom-major (outer layer, then inner), so a bloom-count prefix draws whole blooms. */
function petalGeometry(): InstancedBufferGeometry {
  const lw: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= SEG_L; i++) {
    for (let k = 0; k <= SEG_W; k++) lw.push(i / SEG_L, (k / SEG_W) * 2 - 1);
  }
  for (let i = 0; i < SEG_L; i++) {
    for (let k = 0; k < SEG_W; k++) {
      const a = i * (SEG_W + 1) + k;
      const b = a + SEG_W + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(new Float32Array((lw.length / 2) * 3), 3));
  g.setAttribute("aLW", new Float32BufferAttribute(lw, 2));
  g.setIndex(index);
  const flutter = seededPlacements(BLOOMS.petalSeed, BLOOMS.max * PETALS_PER_BLOOM, (r) => r());
  const petals: number[] = [];
  for (let j = 0; j < BLOOMS.max; j++) {
    for (let i = 0; i < BLOOMS.outerPetals; i++) {
      petals.push(j, (i / BLOOMS.outerPetals) * TAU, 0, flutter[petals.length / 4]);
    }
    for (let i = 0; i < BLOOMS.innerPetals; i++) {
      petals.push(j, ((i + 0.5) / BLOOMS.innerPetals) * TAU, 1, flutter[petals.length / 4]);
    }
  }
  g.setAttribute("aPetal", new InstancedBufferAttribute(new Float32Array(petals), 4));
  g.instanceCount = BLOOMS.max * PETALS_PER_BLOOM;
  return g;
}

/** One camera-facing quad per bloom core. */
function coreGeometry(): BufferGeometry {
  const quad: number[] = [];
  const index: number[] = [];
  for (let j = 0; j < BLOOMS.max; j++) {
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      quad.push(j, cx, cy);
    }
    const o = j * 4;
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(new Float32Array(quad.length), 3));
  g.setAttribute("aQuad", new Float32BufferAttribute(quad, 3));
  g.setIndex(index);
  return g;
}

/** Pools reach about 6 units from a bloom, so the floor is an annulus round the rig, clear of the stage. */
function poolGeometry(): RingGeometry {
  const g = new RingGeometry(3.5, 26, 128, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, BLOOMS.floorY, 0);
  return g;
}

/** Shylight blooms: silk lamps on cables from two rig rings that drop, bloom open round a glowing core, close and rise on a slow cycle, a third of them open at once, casting warm pools on the floor (Studio Drift's Shylight). */
export function ShylightBlooms({ colors, params, speed }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const portrait = bloomPortrait(useFormat().aspect);
  const count = Math.max(1, Math.min(BLOOMS.max, Math.round(params.count)));
  const anchors = useMemo(() => bloomAnchors(count, params.radius), [count, params.radius]);

  const petals = useMemo(petalGeometry, []);
  const cores = useMemo(coreGeometry, []);
  const pools = useMemo(poolGeometry, []);
  useLayoutEffect(
    () => () => {
      petals.dispose();
      cores.dispose();
      pools.dispose();
    },
    [petals, cores, pools],
  );
  const cables = useInkRibbonGeometry(
    () => [
      ...[1, 2].map((ring) =>
        inkLoop(
          Array.from({ length: RIG_POINTS }, (_, i) => [(i / RIG_POINTS) * TAU]),
          [0, ring],
        ),
      ),
      ...Array.from({ length: BLOOMS.max }, (_, j) => inkPolyline([[0], [1]], [j, 0])),
    ],
    [],
  );

  const shared = useMemo(
    () => ({
      uBloom: { value: Array.from({ length: BLOOMS.max }, () => new Vector4()) },
      uAnchor: { value: Array.from({ length: BLOOMS.max }, () => new Vector3()) },
      uSize: { value: 1 },
    }),
    [],
  );
  const mats = useLookMaterials(
    () => ({
      petals: {
        key: "shylight-blooms/petals",
        vertexShader: PETAL_VERTEX,
        fragmentShader: PETAL_FRAGMENT,
        transparent: true,
        depthWrite: true,
        side: DoubleSide,
        uniforms: {
          ...shared,
          uFlutter: { value: 0 },
          uPetal: lookColorUniform("#615b70"),
          uFold: lookColorUniform("#221f2c"),
          uCore: lookColorUniform("#b28c58"),
          uLight: { value: new Vector3(0.3, 0.9, 0.35) },
        },
      },
      cores: {
        key: "shylight-blooms/cores",
        vertexShader: CORE_VERTEX,
        fragmentShader: CORE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: { ...shared, uCore: lookColorUniform("#b28c58") },
      },
      cables: inkRibbonMaterial({
        key: "shylight-blooms/cables",
        path: CABLE_PATH,
        vertex: CABLE_VERTEX_HOOK,
        fragmentShader: CABLE_FRAGMENT,
        side: DoubleSide,
        uniforms: {
          ...shared,
          uRigRadius: { value: 12.5 },
          uCable: lookColorUniform("#4a4656"),
          uOpacity: { value: 0.85 },
        },
        lineWidth: { world: 0.02, px: 1.6, min: 1.5 },
      }),
      pools: {
        key: "shylight-blooms/pools",
        fragmentShader: POOL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          ...shared,
          uCore: lookColorUniform("#b28c58"),
          uPool: { value: 0.14 },
          uCount: { value: 9 },
        },
      },
    }),
    [shared],
  );

  const [petal, fold, core, cable] = colors;
  useLayoutEffect(() => {
    mats.petals.uniforms.uPetal.value.set(petal);
    mats.petals.uniforms.uFold.value.set(fold);
    mats.petals.uniforms.uCore.value.set(core);
    mats.cores.uniforms.uCore.value.set(core);
    mats.pools.uniforms.uCore.value.set(core);
    mats.cables.uniforms.uCable.value.set(cable);
  }, [mats, petal, fold, core, cable]);

  useLayoutEffect(() => {
    for (let j = 0; j < BLOOMS.max; j++) {
      const a = anchors[j];
      shared.uAnchor.value[j].set(a?.x ?? 0, a?.z ?? 0, a?.size ?? 0);
    }
  }, [shared, anchors]);

  useLayoutEffect(() => {
    const cycle = params.cycle;
    const openHeight = params.openHeight + BLOOMS.portraitLift * portrait;
    writeBloomPoses(shared.uBloom.value, anchors, t, cycle, openHeight, params.drop);
    shared.uSize.value = params.size * (1 - BLOOMS.portraitShrink * portrait);
    mats.petals.uniforms.uFlutter.value = flutterPhase(t, cycle);
    mats.cables.uniforms.uRigRadius.value = params.radius;
    mats.cables.uniforms.uOpacity.value = params.cables;
    mats.pools.uniforms.uPool.value = params.pools;
    mats.pools.uniforms.uCount.value = count;
    petals.instanceCount = count * PETALS_PER_BLOOM;
    cores.setDrawRange(0, count * 6);
    showInkStrands(cables, 2 + count);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={pools} material={mats.pools} visible={params.pools > 0} />
      <mesh
        geometry={cables}
        material={mats.cables}
        frustumCulled={false}
        visible={params.cables > 0}
        onBeforeRender={inkRasterSync}
      />
      <mesh geometry={petals} material={mats.petals} frustumCulled={false} />
      <mesh geometry={cores} material={mats.cores} frustumCulled={false} />
    </group>
  );
}
