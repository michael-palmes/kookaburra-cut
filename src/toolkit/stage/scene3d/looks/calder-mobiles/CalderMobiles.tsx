import { useLayoutEffect, useMemo, useRef } from "react";
import { DoubleSide, type InstancedMesh, Shape, ShapeGeometry, Vector2, Vector3 } from "three";
import {
  createInstanceScratch,
  type InstancePose,
  inkPolyline,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
  writeInstanceColors,
  writeInstanceMatrices,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  BASE_SWING,
  buildMobiles,
  createMobileFrame,
  MAX_JOINTS,
  MAX_PADDLES,
  type MobileRig,
  mobileWires,
  type PaddleShape,
  paddleOutline,
  poseMobiles,
} from "./mobiles";
import { PADDLE_FRAGMENT, WIRE_FRAGMENT, WIRE_PATH } from "./shaders";

const SHAPES: PaddleShape[] = [0, 1, 2];
/** Fixed virtual sun: 40 degrees up, 30 degrees round from +z. */
const SUN = new Vector3().setFromSphericalCoords(1, (50 * Math.PI) / 180, (30 * Math.PI) / 180);
const WIRES = mobileWires();
/** Strands drawn for each mobile count (wires are mobile-major). */
const STRANDS_FOR = Array.from({ length: 8 }, (_, n) => WIRES.filter((w) => w.mobile < n).length);
const HAZE = { start: 34, amount: 0.12 } as const;

type Entry = MobileRig["paddles"][number] & { index: number };

/** Calder mobiles: six seeded, balanced mobiles of gum-leaf, crescent and disc paddles on thin wires (Alexander Calder, Marco Mahler). Forward kinematics on the CPU from closed-form sines, written to instance matrices and a joint array each frame; exact loop. */
export function CalderMobiles({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const leafRef = useRef<InstancedMesh>(null);
  const crescentRef = useRef<InstancedMesh>(null);
  const discRef = useRef<InstancedMesh>(null);
  const meshRefs = useMemo(() => [leafRef, crescentRef, discRef], []);
  const rig = useMemo(
    () =>
      buildMobiles({
        count: params.count,
        paddle: params.paddle,
        clearance: params.clearance,
        depth: params.depth,
        seed: params.seed,
      }),
    [params.count, params.paddle, params.clearance, params.depth, params.seed],
  );
  const byShape = useMemo(() => {
    const all: Entry[] = rig.paddles.map((e, index) => ({ ...e, index }));
    return SHAPES.map((s) => all.filter((e) => e.paddle.shape === s));
  }, [rig]);
  const frame = useMemo(createMobileFrame, []);
  const scratch = useMemo(createInstanceScratch, []);
  const pose = useMemo(() => {
    const pd = frame.paddles;
    return (e: Entry, _i: number, out: InstancePose) => {
      const o = e.index * 5;
      out.position.set(pd[o], pd[o + 1], pd[o + 2]);
      out.rotation.set(pd[o + 4], pd[o + 3], -e.paddle.droop, "YXZ");
      out.scale.setScalar(e.paddle.size);
    };
  }, [frame]);
  const shapes = useMemo(
    () =>
      SHAPES.map(
        (s) => new ShapeGeometry(new Shape(paddleOutline(s).map(([x, y]) => new Vector2(x, y)))),
      ),
    [],
  );
  useLayoutEffect(
    () => () => {
      for (const g of shapes) g.dispose();
    },
    [shapes],
  );
  const wires = useInkRibbonGeometry(
    () =>
      WIRES.map((w) =>
        inkPolyline(
          w.joints.map((j) => [j]),
          [w.kind],
        ),
      ),
    [],
  );

  const mats = useLookMaterials(
    () => ({
      paddles: {
        key: "calder-mobiles/paddles",
        fragmentShader: PADDLE_FRAGMENT,
        side: DoubleSide,
        alphaToCoverage: true,
        uniforms: {
          uBacking: lookColorUniform("#0e1011"),
          uSun: { value: SUN.clone() },
          uLight: { value: 0 },
          uHaze: { value: new Vector2(HAZE.start, HAZE.amount) },
        },
      },
      wires: inkRibbonMaterial({
        key: "calder-mobiles/wires",
        path: WIRE_PATH,
        fragmentShader: WIRE_FRAGMENT,
        side: DoubleSide,
        lineWidth: { world: 0.028, min: 1.4 },
        uniforms: {
          uJoint: { value: Array.from({ length: MAX_JOINTS }, () => new Vector3()) },
          uWire: lookColorUniform("#2a2f2d"),
        },
      }),
    }),
    [],
  );

  const [paddleA, paddleB, paddleC, wire] = colors;
  useLayoutEffect(() => {
    const palette = [paddleA, paddleB, paddleC];
    byShape.forEach((list, s) => {
      const mesh = meshRefs[s].current;
      if (mesh)
        writeInstanceColors(mesh, list, (e, _i, out) => out.set(palette[e.paddle.slot]), scratch);
    });
    const mean = (lookLuminance(paddleA) + lookLuminance(paddleB) + lookLuminance(paddleC)) / 3;
    mats.paddles.uniforms.uLight.value = lookLuminance(backing) > mean ? 1 : 0;
    mats.paddles.uniforms.uBacking.value.set(backing);
    mats.wires.uniforms.uWire.value.set(wire);
  }, [mats, meshRefs, byShape, scratch, paddleA, paddleB, paddleC, wire, backing]);

  useLayoutEffect(() => {
    const period = params.period;
    poseMobiles(rig, loopSeconds(t, period), period, params.swing / BASE_SWING, frame);
    for (let s = 0; s < SHAPES.length; s++) {
      const mesh = meshRefs[s].current;
      if (mesh) writeInstanceMatrices(mesh, byShape[s], pose, scratch);
    }
    const joints = mats.wires.uniforms.uJoint.value as Vector3[];
    for (let i = 0; i < rig.jointCount; i++) joints[i].fromArray(frame.joints, i * 3);
    showInkStrands(wires, STRANDS_FOR[rig.mobiles.length]);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      {SHAPES.map((s) => (
        <instancedMesh
          key={s}
          ref={meshRefs[s]}
          args={[undefined, undefined, MAX_PADDLES]}
          geometry={shapes[s]}
          material={mats.paddles}
          frustumCulled={false}
        />
      ))}
      <mesh
        geometry={wires}
        material={mats.wires}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
