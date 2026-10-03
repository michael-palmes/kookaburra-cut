import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, CylinderGeometry, DoubleSide, type InstancedMesh, Vector3 } from "three";
import {
  type InstancePose,
  lookColorUniform,
  lookLuminance,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  LOUVRE,
  type LouvreSlat,
  louvreCount,
  louvrePhase,
  louvrePitch,
  louvreRowLag,
  louvreRowSize,
  louvreRows,
  louvreSlats,
  louvreSun,
} from "./louvre";
import { LOUVRE_FRAGMENT, RAIL_VERTEX, SLAT_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const CAPACITY = LOUVRE.maxSlats * LOUVRE.maxRows;
const RAIL_HEIGHT = 0.16;
const RAIL_LIFT = 0.2;

/** Unit slat: x and z centred, y from the foot (0) to the top (1); the vertex stage scales and turns it. */
function slatGeometry(): BoxGeometry {
  const g = new BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

const anchorPose = (s: LouvreSlat, _i: number, out: InstancePose) => {
  out.position.set(s.x, s.y, s.z);
};

/** Louvre ring: a colonnade of two-faced slats round the stage under a thin rail. One turning front sweeps the ring and every slat makes one eased full turn as it passes, then settles (Penumbra louvres, Ned Kahn's Wind Veil). Static anchors, every turn in the vertex stage. */
export function LouvreRing({ colors, params, speed, backing }: Scene3dLookProps) {
  const slatsRef = useRef<InstancedMesh>(null);
  const t = useLookTime(speed);
  const slat = useMemo(slatGeometry, []);
  const rail = useMemo(() => new CylinderGeometry(1, 1, RAIL_HEIGHT, 192, 1, true), []);
  useLayoutEffect(
    () => () => {
      slat.dispose();
      rail.dispose();
    },
    [slat, rail],
  );

  const count = louvreCount(params.count);
  const rows = louvreRows(params.rows);
  const { radius, height } = params;
  const slats = useMemo(
    () => louvreSlats(count, rows, radius, height),
    [count, rows, radius, height],
  );
  const size = useMemo(() => louvreRowSize(height, rows), [height, rows]);
  const meshes = useMemo(() => [slatsRef], []);
  useStaticInstancedLayout(meshes, slats, anchorPose);

  const mats = useLookMaterials(() => {
    const shared = {
      uA: lookColorUniform("#222b30"),
      uB: lookColorUniform("#61564a"),
      uFrame: lookColorUniform("#30373a"),
      uBacking: lookColorUniform("#0e1214"),
      uSun: { value: new Vector3(...louvreSun()) },
      uLightMode: { value: 0 },
      uTop: { value: 6 },
    };
    return {
      slats: {
        key: "louvre-ring/slats",
        vertexShader: SLAT_VERTEX,
        fragmentShader: LOUVRE_FRAGMENT,
        alphaToCoverage: true,
        uniforms: {
          ...shared,
          uPhase: { value: 0 },
          uFront: { value: 0.3 },
          uRowLag: { value: 0 },
          uRowPitch: { value: 8 },
          uSlatH: { value: 8 },
          uSlatW: { value: 0.28 },
          uPitch: { value: 0.53 },
        },
      },
      rail: {
        key: "louvre-ring/rail",
        vertexShader: RAIL_VERTEX,
        fragmentShader: LOUVRE_FRAGMENT,
        alphaToCoverage: true,
        side: DoubleSide,
        uniforms: shared,
      },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.slats.uniforms;
    const pitch = louvrePitch(count, radius);
    u.uPhase.value = louvrePhase(t, params.period);
    u.uFront.value = params.front;
    u.uRowLag.value = louvreRowLag(params.front, rows);
    u.uRowPitch.value = size.pitch;
    u.uSlatH.value = size.slat;
    u.uSlatW.value = pitch * LOUVRE.fill;
    u.uPitch.value = pitch;
    u.uTop.value = LOUVRE.bottom + height;
  });
  useLayoutEffect(() => {
    const u = mats.slats.uniforms;
    u.uA.value.set(colors[0]);
    u.uB.value.set(colors[1]);
    u.uFrame.value.set(colors[2]);
    u.uBacking.value.set(backing);
    u.uLightMode.value = lookLuminance(backing) > lookLuminance(colors[0]) ? 1 : 0;
  }, [mats, colors[0], colors[1], colors[2], backing]);

  const railPose = useMemo(() => {
    const ring = radius + RAIL_LIFT;
    return {
      position: [0, LOUVRE.bottom + height + RAIL_LIFT, 0] as const,
      scale: [ring, 1, ring] as const,
    };
  }, [radius, height]);
  return (
    <group userData={ROOT_DATA}>
      <instancedMesh
        ref={slatsRef}
        args={[undefined, undefined, CAPACITY]}
        geometry={slat}
        material={mats.slats}
        frustumCulled={false}
      />
      <mesh
        geometry={rail}
        material={mats.rail}
        position={railPose.position}
        scale={railPose.scale}
        frustumCulled={false}
      />
    </group>
  );
}
