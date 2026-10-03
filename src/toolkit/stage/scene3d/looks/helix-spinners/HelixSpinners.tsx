import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type InstancedMesh,
  Vector2,
  Vector3,
} from "three";
import {
  type InstancePose,
  inkPolyline,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { BAR_FRAGMENT, BAR_VERTEX, HUB_FRAGMENT, ROD_FRAGMENT } from "./shaders";
import {
  barCount,
  layoutSpinners,
  MAX_SPINNERS,
  ROD_TOP,
  SPINNER_LOOP,
  type Spinner,
  spinnerBarAttributes,
} from "./spinners";

const TAU = Math.PI * 2;
const SUN = new Vector3(0.4, 0.5, 0.77).normalize();
const FOG = { from: 20, amount: 0.4 } as const;
const HUB_LIFT = 0.25;
const ROD_POINTS = 4;

/** A flat bar two units long with rounded ends, centred on the spinner axis. */
function barGeometry(): BoxGeometry {
  const bar = new BoxGeometry(2, 0.13, 0.05, 12, 1, 1);
  const p = bar.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const e = Math.max(0, (Math.abs(p.getX(i)) - 0.85) / 0.15);
    p.setY(i, p.getY(i) * Math.sqrt(Math.max(0.06, 1 - e * e)));
  }
  bar.computeVertexNormals();
  return bar;
}

const hubPose = (sp: Spinner, _i: number, out: InstancePose) => {
  out.position.set(sp.x, sp.bottom + sp.len + HUB_LIFT, sp.z);
};

/** Helix spinners: a grove of hanging spinners, each two interleaved helices of flat bars turning opposite ways (Jennifer Townley's Asinas and Bussola), so each twist pours down its spinner as the two beat. One instanced bar draw posed in the vertex shader, F2 rods and instanced hubs; exact 120 s loop. */
export function HelixSpinners({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const spinners = useMemo(
    () =>
      layoutSpinners({
        count: params.count,
        length: params.length,
        twist: params.twist,
        turn: params.turn,
        clearance: params.clearance,
      }),
    [params.count, params.length, params.twist, params.turn, params.clearance],
  );
  const bar = useMemo(barGeometry, []);
  const hub = useMemo(() => new CylinderGeometry(0.16, 0.22, 0.34, 12), []);
  const bars = useMemo(() => {
    const g = new InstancedBufferGeometry();
    g.setIndex(bar.index);
    g.setAttribute("position", bar.attributes.position);
    g.setAttribute("normal", bar.attributes.normal);
    const data = spinnerBarAttributes(spinners);
    g.setAttribute("aSp", new InstancedBufferAttribute(data.sp, 4));
    g.setAttribute("aBar", new InstancedBufferAttribute(data.bar, 4));
    g.instanceCount = barCount(spinners);
    return g;
  }, [bar, spinners]);
  useLayoutEffect(() => () => bars.dispose(), [bars]);
  useLayoutEffect(
    () => () => {
      bar.dispose();
      hub.dispose();
    },
    [bar, hub],
  );
  const rods = useInkRibbonGeometry(
    () =>
      spinners.map((sp) => {
        const y0 = sp.bottom - 0.2;
        const points = Array.from({ length: ROD_POINTS }, (_, k) => [
          sp.x,
          y0 + ((ROD_TOP - y0) * k) / (ROD_POINTS - 1),
          sp.z,
        ]);
        return inkPolyline(points, [sp.bottom + sp.len]);
      }),
    [spinners],
  );
  const hubRef = useRef<InstancedMesh>(null);
  const hubRefs = useMemo(() => [hubRef], []);
  useStaticInstancedLayout(hubRefs, spinners, hubPose);

  const mats = useLookMaterials(() => {
    const shared = {
      uBacking: lookColorUniform("#0c0b0a"),
      uSun: { value: SUN.clone() },
      uLight: { value: 0 },
      uFog: { value: new Vector2(FOG.from, FOG.amount) },
    };
    return {
      bars: {
        key: "helix-spinners/bars",
        vertexShader: BAR_VERTEX,
        fragmentShader: BAR_FRAGMENT,
        alphaToCoverage: true,
        uniforms: {
          ...shared,
          uPhase: { value: 0 },
          uHelixA: lookColorUniform("#6d523e"),
          uHelixB: lookColorUniform("#3a4b53"),
        },
      },
      hubs: {
        key: "helix-spinners/hubs",
        fragmentShader: HUB_FRAGMENT,
        alphaToCoverage: true,
        uniforms: { ...shared, uRod: lookColorUniform("#221e1b") },
      },
      rods: inkRibbonMaterial({
        key: "helix-spinners/rods",
        fragmentShader: ROD_FRAGMENT,
        side: DoubleSide,
        lineWidth: { world: 0.05, min: 1.3 },
        uniforms: { uRod: lookColorUniform("#221e1b"), uOpacity: { value: 0.35 } },
      }),
    };
  }, []);

  const [helixA, helixB, rod] = colors;
  useLayoutEffect(() => {
    const light =
      lookLuminance(backing) > (lookLuminance(helixA) + lookLuminance(helixB)) / 2 ? 1 : 0;
    const b = mats.bars.uniforms;
    b.uHelixA.value.set(helixA);
    b.uHelixB.value.set(helixB);
    b.uBacking.value.set(backing);
    b.uLight.value = light;
    mats.hubs.uniforms.uRod.value.set(rod);
    mats.rods.uniforms.uRod.value.set(rod);
  }, [mats, helixA, helixB, rod, backing]);

  useLayoutEffect(() => {
    mats.bars.uniforms.uPhase.value = (TAU * loopSeconds(t, SPINNER_LOOP)) / SPINNER_LOOP;
    mats.rods.uniforms.uOpacity.value = params.rods;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={bars} material={mats.bars} frustumCulled={false} />
      <instancedMesh
        ref={hubRef}
        args={[undefined, undefined, MAX_SPINNERS]}
        geometry={hub}
        material={mats.hubs}
        frustumCulled={false}
      />
      <mesh
        geometry={rods}
        material={mats.rods}
        frustumCulled={false}
        visible={params.rods > 0}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
