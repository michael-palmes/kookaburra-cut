import { useLayoutEffect, useMemo } from "react";
import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LatheGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import {
  inkRasterSync,
  inkRibbonMaterial,
  inkStrands,
  lookColorUniform,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  PENDULUM,
  PENDULUM_CAPACITY,
  pendulumPhase,
  pendulumTotal,
  swingBase,
  writeSunDirection,
} from "./pendulum";
import {
  BOB_FRAGMENT,
  BOB_VERTEX,
  RAIL_FRAGMENT,
  RAIL_VERTEX,
  THREAD_FRAGMENT,
  THREAD_PATH,
} from "./shaders";

const RAIL_TUBE = 0.07;

/** Turned plumb bob (knob, neck, shoulder, body, then a long cone to the point), top at y 0, one instance per pendulum. */
function bobGeometry(): InstancedBufferGeometry {
  const profile = [
    [0.0, 0.0],
    [0.03, -0.004],
    [0.034, -0.03],
    [0.022, -0.06],
    [0.07, -0.075],
    [0.125, -0.11],
    [0.14, -0.16],
    [0.14, -0.27],
    [0.125, -0.31],
    [0.07, -0.47],
    [0.0, -0.66],
  ].map(([r, y]) => new Vector2(r, y));
  const lathe = new LatheGeometry(profile, 12);
  lathe.scale(1.3, 1.3, 1.3);
  const g = new InstancedBufferGeometry();
  g.index = lathe.index;
  for (const name of ["position", "normal"]) g.setAttribute(name, lathe.getAttribute(name));
  g.setAttribute(
    "aPendulum",
    new InstancedBufferAttribute(
      Float32Array.from({ length: PENDULUM_CAPACITY }, (_, i) => i),
      1,
    ),
  );
  g.instanceCount = PENDULUM_CAPACITY;
  return g;
}

/** A unit-radius torus instanced per rail; the vertex stage sets each rail's radius and height. */
function railGeometry(): InstancedBufferGeometry {
  const torus = new TorusGeometry(1, RAIL_TUBE, 8, 192);
  const g = new InstancedBufferGeometry();
  g.index = torus.index;
  for (const name of ["position", "normal"]) g.setAttribute(name, torus.getAttribute(name));
  g.setAttribute(
    "aRail",
    new InstancedBufferAttribute(
      Float32Array.from({ length: PENDULUM.maxRails }, (_, i) => i),
      1,
    ),
  );
  g.instanceCount = PENDULUM.maxRails;
  return g;
}

/** Pendulum ring: tiers of turned plumb bobs on threads from overhead rails, a pendulum wave whose lengths step round each rail so V-shaped snakes and helices drift across the rows and every bob realigns exactly once per period (Kinetic Rain's visible threads). */
export function PendulumRing({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const count = Math.max(1, Math.min(PENDULUM.maxCount, Math.round(params.count)));
  const rails = Math.max(1, Math.min(PENDULUM.maxRails, Math.round(params.rows)));

  const bobs = useMemo(bobGeometry, []);
  const railsGeo = useMemo(railGeometry, []);
  useLayoutEffect(
    () => () => {
      bobs.dispose();
      railsGeo.dispose();
    },
    [bobs, railsGeo],
  );
  const threads = useInkRibbonGeometry(
    () => inkStrands(PENDULUM_CAPACITY, 2, (_, i) => [i], { data: (s) => [s] }),
    [],
  );

  const shared = useMemo(
    () => ({
      uCount: { value: 48 },
      uRadius: { value: 11 },
      uSwing: { value: 0.5 },
      uBase: { value: 48 },
      uPhase: { value: 0 },
      uSheen: lookColorUniform("#6c5a3b"),
      uSun: { value: new Vector3(0, 1, 0) },
      uBacking: lookColorUniform("#0e0f11"),
    }),
    [],
  );
  const mats = useLookMaterials(
    () => ({
      bobs: {
        key: "pendulum-ring/bobs",
        vertexShader: BOB_VERTEX,
        fragmentShader: BOB_FRAGMENT,
        alphaToCoverage: true,
        uniforms: { ...shared, uBob: lookColorUniform("#5f4f37") },
      },
      threads: inkRibbonMaterial({
        key: "pendulum-ring/threads",
        path: THREAD_PATH,
        fragmentShader: THREAD_FRAGMENT,
        side: DoubleSide,
        uniforms: {
          ...shared,
          uThread: lookColorUniform("#44423d"),
          uOpacity: { value: 0.8 },
        },
        lineWidth: { world: 0.014, px: 0, min: 1.5 },
      }),
      rails: {
        key: "pendulum-ring/rails",
        vertexShader: RAIL_VERTEX,
        fragmentShader: RAIL_FRAGMENT,
        alphaToCoverage: true,
        uniforms: { ...shared, uRail: lookColorUniform("#383d42") },
      },
    }),
    [shared],
  );

  const [bob, sheen, thread, rail] = colors;
  useLayoutEffect(() => {
    mats.bobs.uniforms.uBob.value.set(bob);
    shared.uSheen.value.set(sheen);
    mats.threads.uniforms.uThread.value.set(thread);
    mats.rails.uniforms.uRail.value.set(rail);
    shared.uBacking.value.set(backing);
  }, [mats, shared, bob, sheen, thread, rail, backing]);

  useLayoutEffect(() => {
    const period = params.period;
    shared.uCount.value = count;
    shared.uRadius.value = params.radius;
    shared.uSwing.value = params.swing;
    shared.uBase.value = swingBase(period);
    shared.uPhase.value = pendulumPhase(t, period, params.epoch);
    writeSunDirection(shared.uSun.value, t, period);
    const total = pendulumTotal(count, rails);
    bobs.instanceCount = total;
    showInkStrands(threads, total);
    railsGeo.instanceCount = rails;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={railsGeo} material={mats.rails} frustumCulled={false} />
      <mesh geometry={bobs} material={mats.bobs} frustumCulled={false} />
      <mesh
        geometry={threads}
        material={mats.threads}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
