import { useLayoutEffect, useMemo } from "react";
import {
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  Vector3,
} from "three";
import { lookColorUniform, loopSeconds, useLookMaterials, useLookTime } from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { WHEEL_FRAGMENT, WHEEL_VERTEX } from "./shaders";
import { CLOCKWORK, type ClockWheel, clockTeeth, clockworkLayout } from "./train";

const TAU = Math.PI * 2;
/** The virtual sun circles once per 240 s, low under the ceiling so the turned-brass streaks travel round the wheels. */
const SUN_PERIOD = 240;
const SUN_ELEVATION = 0.7;

/** One unit quad instanced per wheel: hub, plane basis, (radius, teeth, spokes, kind) and (phase, turns per tooth). */
export function clockworkGeometry(wheels: readonly ClockWheel[]): InstancedBufferGeometry {
  const n = wheels.length;
  const aC = new Float32Array(n * 3);
  const aU = new Float32Array(n * 3);
  const aV = new Float32Array(n * 3);
  const aW = new Float32Array(n * 4);
  const aS = new Float32Array(n * 2);
  wheels.forEach((w, i) => {
    aC.set(w.centre, i * 3);
    aU.set(w.u, i * 3);
    aV.set(w.v, i * 3);
    aW.set([w.radius, w.teeth, w.spokes, w.kind], i * 4);
    aS.set([w.phase, w.turns], i * 2);
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute("aC", new InstancedBufferAttribute(aC, 3));
  g.setAttribute("aU", new InstancedBufferAttribute(aU, 3));
  g.setAttribute("aV", new InstancedBufferAttribute(aV, 3));
  g.setAttribute("aW", new InstancedBufferAttribute(aW, 4));
  g.setAttribute("aS", new InstancedBufferAttribute(aS, 2));
  g.instanceCount = n;
  g.boundingSphere = new Sphere(new Vector3(), 40);
  return g;
}

/** Skeleton clockwork: pierced brass wheels and steel pinions meshing in short trains on overhead planes, outer trains leaning toward the stage, and two hazed frieze rows of half-wheels at the horizon. One instanced draw; every wheel passes the same teeth per second, so the trains turn together. */
export function SkeletonClockwork({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const layout = useMemo(
    () =>
      clockworkLayout({
        module: params.module,
        ceiling: params.ceiling,
        frieze: params.frieze,
        seed: params.seed,
      }),
    [params.module, params.ceiling, params.frieze, params.seed],
  );
  const geometry = useMemo(() => clockworkGeometry(layout.wheels), [layout]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const mats = useLookMaterials(
    () => ({
      wheels: {
        key: "skeleton-clockwork/wheels",
        vertexShader: WHEEL_VERTEX,
        fragmentShader: WHEEL_FRAGMENT,
        alphaToCoverage: true,
        side: DoubleSide,
        uniforms: {
          uTeeth: { value: 0 },
          uModule: { value: 0.3 },
          uWheel: lookColorUniform("#62502f"),
          uArbor: lookColorUniform("#34434a"),
          uFrieze: lookColorUniform("#2a2620"),
          uSheen: lookColorUniform("#6a5a3c"),
          uBacking: lookColorUniform("#0e0d0c"),
          uSun: { value: new Vector3(0, -1, 0) },
        },
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const u = mats.wheels.uniforms;
    u.uWheel.value.set(colors[0]);
    u.uArbor.value.set(colors[1]);
    u.uFrieze.value.set(colors[2]);
    u.uSheen.value.set(colors[3]);
    u.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], colors[3], backing]);

  const planes = Math.min(CLOCKWORK.maxPlanes, Math.max(1, Math.round(params.planes)));
  useLayoutEffect(() => {
    const u = mats.wheels.uniforms;
    u.uTeeth.value = clockTeeth(t, params.rate, params.tick);
    u.uModule.value = params.module;
    const az = (TAU * loopSeconds(t, SUN_PERIOD)) / SUN_PERIOD + 2.2;
    u.uSun.value.set(
      Math.cos(SUN_ELEVATION) * Math.sin(az),
      -Math.sin(SUN_ELEVATION),
      Math.cos(SUN_ELEVATION) * Math.cos(az),
    );
    geometry.instanceCount = layout.ends[planes];
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={geometry} material={mats.wheels} frustumCulled={false} />
    </group>
  );
}
