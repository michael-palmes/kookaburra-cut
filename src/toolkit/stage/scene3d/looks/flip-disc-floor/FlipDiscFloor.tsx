import { useLayoutEffect, useMemo, useRef } from "react";
import { DoubleSide, type InstancedMesh, type IUniform, PlaneGeometry, Vector3 } from "three";
import {
  type InstancePose,
  type LatticePoint,
  lookColorUniform,
  useLookMaterials,
  useLookTime,
  useStaticInstancedLayout,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { discRadius, FLIP, FLIP_CAPACITY, flipBias, flipPhase, squareLattice } from "./board";
import { BOARD_FRAGMENT, BOARD_VERTEX, DISC_FRAGMENT, DISC_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const CEILING_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, FLIP.boardY, 0];
const CEILING_POSITION: [number, number, number] = [0, FLIP.ceilingY, 0];
const DEG = Math.PI / 180;

const anchorPose = (p: LatticePoint, _i: number, out: InstancePose) => {
  out.position.set(p.x, 0, p.z);
};

/** Per board: which side it faces, its height and its strength (the ceiling's slider). */
const plane = (side: 1 | -1, level: number): Record<string, IUniform> => ({
  uSide: { value: side },
  uLevel: { value: level },
  uStrength: { value: 1 },
});

/** Flip-disc floor: about 11k flip-discs on a board (BREAKFAST's flip-disc weather fronts, Rozin's Wooden Mirror) with Face-coloured fronts crossing them as each disc rises on its axle, round a still clearing on Back, plus a mirrored ceiling board so the front view frames the headline. Static anchors, every pose in the vertex shader; unlit. */
export function FlipDiscFloor({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const floorRef = useRef<InstancedMesh>(null);
  const ceilingRef = useRef<InstancedMesh>(null);
  const quad = useMemo(() => new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), []);
  useLayoutEffect(() => () => quad.dispose(), [quad]);
  const cells = useMemo(
    () => squareLattice(params.pitch, params.reach),
    [params.pitch, params.reach],
  );
  const meshes = useMemo(() => [floorRef, ceilingRef], []);
  useStaticInstancedLayout(meshes, cells, anchorPose);

  const mats = useLookMaterials(() => {
    // One set of field and tone uniforms shared by every part, so the boards and discs read one field.
    const shared: Record<string, IUniform> = {
      uPhase: { value: 0 },
      uBias: { value: 0.12 },
      uClear: { value: 4 },
      uFront: { value: 1 },
      uSnap: { value: 0.06 },
      uReach: { value: 26 },
      uFace: lookColorUniform("#5e5631"),
      uBack: lookColorUniform("#252b30"),
      uBoard: lookColorUniform("#181c1f"),
      uBacking: lookColorUniform("#0b0e10"),
      uPitch: { value: 0.44 },
      uR: { value: 0.18 },
      uAxle: { value: 0 },
      uSun: { value: new Vector3(0.45, 0.8, 0.4).normalize() },
    };
    const board = { vertexShader: BOARD_VERTEX, fragmentShader: BOARD_FRAGMENT };
    const discs = {
      vertexShader: DISC_VERTEX,
      fragmentShader: DISC_FRAGMENT,
      alphaToCoverage: true,
      side: DoubleSide,
    };
    return {
      floorBoard: {
        ...board,
        key: "flip-disc-floor/board",
        uniforms: { ...shared, ...plane(1, FLIP.boardY) },
      },
      floorDiscs: {
        ...discs,
        key: "flip-disc-floor/discs",
        uniforms: { ...shared, ...plane(1, FLIP.boardY) },
      },
      ceilingBoard: {
        ...board,
        key: "flip-disc-floor/board",
        uniforms: { ...shared, ...plane(-1, FLIP.ceilingY) },
      },
      ceilingDiscs: {
        ...discs,
        key: "flip-disc-floor/discs",
        uniforms: { ...shared, ...plane(-1, FLIP.ceilingY) },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.floorBoard.uniforms;
    u.uFace.value.set(colors[0]);
    u.uBack.value.set(colors[1]);
    u.uBoard.value.set(colors[2]);
    u.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const u = mats.floorBoard.uniforms;
    u.uPhase.value = flipPhase(t, params.period);
    u.uBias.value = flipBias(params.cover);
    u.uClear.value = params.clear;
    u.uFront.value = params.scale;
    u.uSnap.value = params.snap;
    u.uReach.value = params.reach;
    u.uPitch.value = params.pitch;
    u.uR.value = discRadius(params.pitch);
    u.uAxle.value = params.axle * DEG;
    mats.ceilingBoard.uniforms.uStrength.value = params.ceiling;
    mats.ceilingDiscs.uniforms.uStrength.value = params.ceiling;
  });

  const showCeiling = params.ceiling > 0;
  return (
    <group userData={ROOT_DATA}>
      <mesh
        material={mats.floorBoard}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        scale={FLIP.boardRadius}
        frustumCulled={false}
      >
        <circleGeometry args={[1, 96]} />
      </mesh>
      <instancedMesh
        ref={floorRef}
        args={[undefined, undefined, FLIP_CAPACITY]}
        geometry={quad}
        material={mats.floorDiscs}
        frustumCulled={false}
      />
      <mesh
        material={mats.ceilingBoard}
        position={CEILING_POSITION}
        rotation={CEILING_ROTATION}
        scale={FLIP.boardRadius}
        frustumCulled={false}
        visible={showCeiling}
      >
        <circleGeometry args={[1, 96]} />
      </mesh>
      <instancedMesh
        ref={ceilingRef}
        args={[undefined, undefined, FLIP_CAPACITY]}
        geometry={quad}
        material={mats.ceilingDiscs}
        frustumCulled={false}
        visible={showCeiling}
      />
    </group>
  );
}
