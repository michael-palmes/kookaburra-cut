import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  type InstancedMesh,
  type IUniform,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
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
  bayCentres,
  GALLERY,
  LAMP,
  MAX_LAMPS,
  MAX_PIERS,
  pierCentres,
  swayPhase,
  writeCloudPhases,
} from "./bays";
import {
  BRASS_FRAGMENT,
  BRASS_VERTEX,
  FLAT_FRAGMENT,
  FLOOR_FRAGMENT,
  GLASS_FRAGMENT,
  PIER_FRAGMENT,
  WALL_FRAGMENT,
} from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const G = GALLERY;
const LENGTH = G.halfLength * 2;
const DARK_LUMINANCE = 0.2;

/** A unit pier standing on the floor against the wall: x -0.5..0.5, y 0..1, z 0..1 out from the wall, with its front, both returns and its top (no back or underside). */
function pierGeometry(): BufferGeometry {
  const faces: [number[], number[][]][] = [
    [
      [0, 0, 1],
      [
        [-0.5, 0, 1],
        [0.5, 0, 1],
        [0.5, 1, 1],
        [-0.5, 1, 1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [-0.5, 0, 0],
        [-0.5, 0, 1],
        [-0.5, 1, 1],
        [-0.5, 1, 0],
      ],
    ],
    [
      [1, 0, 0],
      [
        [0.5, 0, 1],
        [0.5, 0, 0],
        [0.5, 1, 0],
        [0.5, 1, 1],
      ],
    ],
    [
      [0, 1, 0],
      [
        [-0.5, 1, 1],
        [0.5, 1, 1],
        [0.5, 1, 0],
        [-0.5, 1, 0],
      ],
    ],
  ];
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  faces.forEach(([n, corners], f) => {
    for (const c of corners) {
      position.push(...c);
      normal.push(...n);
    }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const b = f * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/** The picture light's three parts in its own frame (origin on the wall at the lamp height): the can aimed down at the bay, the arm from the wall plate to the can's back, and the plate. */
export function lampGeometries() {
  const aim = new Vector3(...LAMP.aim);
  const can = new CylinderGeometry(LAMP.canRadius, LAMP.canRadius, LAMP.canLength, 32, 1)
    .applyQuaternion(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), aim.clone().negate()),
    )
    .translate(0, 0, LAMP.reach);
  const from = new Vector3(0, LAMP.armRise, LAMP.plate[2]);
  const to = new Vector3(0, 0, LAMP.reach).addScaledVector(aim, -LAMP.canLength / 2);
  const dir = to.clone().sub(from);
  const arm = new CylinderGeometry(LAMP.armRadius, LAMP.armRadius, dir.length(), 12, 1)
    .applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()))
    .translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  const plate = new BoxGeometry(...LAMP.plate).translate(0, LAMP.armRise, LAMP.plate[2] / 2);
  return { can, arm, plate };
}

function sharedUniforms(): Record<string, IUniform> {
  return {
    uPlaster: lookColorUniform("#3b3530"),
    uOak: lookColorUniform("#4a2f22"),
    uShade: lookColorUniform("#15120f"),
    uBrass: lookColorUniform("#705c3b"),
    uLamp: lookColorUniform("#a8895c"),
    uBacking: lookColorUniform("#110f0d"),
    uDark: { value: 1 },
    uPitch: { value: 9 },
    uPierDepth: { value: 0.6 },
    uLampY: { value: 2.6 },
    uPools: { value: 0.85 },
    uDaylight: { value: 0.25 },
    uClouds: { value: 0.4 },
    uCloud: { value: new Vector3() },
  };
}

interface PierItem {
  x: number;
  depth: number;
}

interface LampItem {
  x: number;
  y: number;
}

function pierPose(p: PierItem, _i: number, out: InstancePose): void {
  out.position.set(p.x, G.floorY, G.wallZ);
  out.scale.set(G.pierWidth, G.sillY - G.floorY, p.depth);
}

function lampPose(l: LampItem, _i: number, out: InstancePose): void {
  out.position.set(l.x, l.y, G.wallZ);
}

const WALL_POSITION: [number, number, number] = [0, (G.floorY + G.sillY) / 2, G.wallZ];
const STRIP_POSITION: [number, number, number] = [0, (G.headY + G.ceilingY) / 2, G.wallZ];
const FAR_POSITION: [number, number, number] = [0, (G.floorY + G.ceilingY) / 2, G.frontZ];
const GLASS_POSITION: [number, number, number] = [0, (G.sillY + G.headY) / 2, G.wallZ - G.reveal];
const SILL_POSITION: [number, number, number] = [0, G.sillY, G.wallZ - G.reveal / 2];
const HEAD_POSITION: [number, number, number] = [0, G.headY, G.wallZ - G.reveal / 2];
const ROOM_MID_Z = (G.wallZ + G.frontZ) / 2;
const FLOOR_POSITION: [number, number, number] = [0, G.floorY, ROOM_MID_Z];
const CEILING_POSITION: [number, number, number] = [0, G.ceilingY, ROOM_MID_Z];

/** Gallery: a long top-lit gallery behind the stage. Clear plaster bays between shallow piers along the hanging wall, each under a brass picture light whose pool falls where a scene hangs its work; oak boards running toward the wall with a satin reflection of the lit bays; a clerestory band of leafy daylight above the piers, its light breathing as cloud passes. Unlit and analytic, so colours hold exactly and fill rate stays low; motion is the cloud and the leaves, on the absolute look clock. */
export function Gallery({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const piersRef = useRef<InstancedMesh>(null);
  const cansRef = useRef<InstancedMesh>(null);
  const armsRef = useRef<InstancedMesh>(null);
  const platesRef = useRef<InstancedMesh>(null);

  const geometry = useMemo(() => {
    const lamp = lampGeometries();
    return {
      wall: new PlaneGeometry(LENGTH, G.sillY - G.floorY),
      strip: new PlaneGeometry(LENGTH, G.ceilingY - G.headY),
      far: new PlaneGeometry(LENGTH, G.ceilingY - G.floorY).rotateY(Math.PI),
      glass: new PlaneGeometry(LENGTH, G.headY - G.sillY),
      sill: new PlaneGeometry(LENGTH, G.reveal).rotateX(-Math.PI / 2),
      head: new PlaneGeometry(LENGTH, G.reveal).rotateX(Math.PI / 2),
      floor: new PlaneGeometry(LENGTH, G.frontZ - G.wallZ).rotateX(-Math.PI / 2),
      ceiling: new PlaneGeometry(LENGTH, G.frontZ - G.wallZ).rotateX(Math.PI / 2),
      pier: pierGeometry(),
      ...lamp,
    };
  }, []);
  useLayoutEffect(
    () => () => {
      for (const g of Object.values(geometry)) g.dispose();
    },
    [geometry],
  );

  const mats = useLookMaterials(() => {
    const shared = sharedUniforms();
    return {
      wall: { key: "gallery/wall", fragmentShader: WALL_FRAGMENT, uniforms: shared },
      pier: { key: "gallery/pier", fragmentShader: PIER_FRAGMENT, uniforms: shared },
      floor: {
        key: "gallery/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { ...shared, uBoard: { value: 0.42 } },
      },
      flat: { key: "gallery/flat", fragmentShader: FLAT_FRAGMENT, uniforms: shared },
      glass: {
        key: "gallery/glass",
        fragmentShader: GLASS_FRAGMENT,
        uniforms: { ...shared, uSway: { value: 0 } },
      },
      can: {
        key: "gallery/can",
        vertexShader: BRASS_VERTEX,
        fragmentShader: BRASS_FRAGMENT,
        defines: { GA_LENS: 1 },
        uniforms: shared,
      },
      fitting: {
        key: "gallery/fitting",
        vertexShader: BRASS_VERTEX,
        fragmentShader: BRASS_FRAGMENT,
        uniforms: shared,
      },
    };
  }, []);
  const u = mats.wall.uniforms;

  const [plaster, oak, shade, brass, lamp] = colors;
  useLayoutEffect(() => {
    u.uPlaster.value.set(plaster);
    u.uOak.value.set(oak);
    u.uShade.value.set(shade);
    u.uBrass.value.set(brass);
    u.uLamp.value.set(lamp);
    u.uBacking.value.set(backing);
    u.uDark.value = lookLuminance(plaster) < DARK_LUMINANCE ? 1 : 0;
  }, [u, plaster, oak, shade, brass, lamp, backing]);

  const pitch = params.bayWidth;
  const depth = params.pierDepth;
  const lampY = params.lampHeight;
  const piers = useMemo<PierItem[]>(
    () => pierCentres(pitch).map((x) => ({ x, depth })),
    [pitch, depth],
  );
  const lamps = useMemo<LampItem[]>(
    () => bayCentres(pitch).map((x) => ({ x, y: lampY })),
    [pitch, lampY],
  );
  const pierMeshes = useMemo(() => [piersRef], []);
  const lampMeshes = useMemo(() => [cansRef, armsRef, platesRef], []);
  useStaticInstancedLayout(pierMeshes, piers, pierPose);
  useStaticInstancedLayout(lampMeshes, lamps, lampPose);

  useLayoutEffect(() => {
    u.uPitch.value = pitch;
    u.uPierDepth.value = depth;
    u.uLampY.value = lampY;
    u.uPools.value = params.pools;
    u.uDaylight.value = params.daylight;
    u.uClouds.value = params.clouds;
    writeCloudPhases(u.uCloud.value, t);
    mats.floor.uniforms.uBoard.value = params.boards;
    mats.glass.uniforms.uSway.value = swayPhase(t);
  }, [
    u,
    mats,
    t,
    pitch,
    depth,
    lampY,
    params.pools,
    params.daylight,
    params.clouds,
    params.boards,
  ]);

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry.wall} material={mats.wall} position={WALL_POSITION} />
      <mesh geometry={geometry.strip} material={mats.wall} position={STRIP_POSITION} />
      <mesh geometry={geometry.far} material={mats.wall} position={FAR_POSITION} />
      <mesh geometry={geometry.glass} material={mats.glass} position={GLASS_POSITION} />
      <mesh geometry={geometry.sill} material={mats.flat} position={SILL_POSITION} />
      <mesh geometry={geometry.head} material={mats.flat} position={HEAD_POSITION} />
      <mesh geometry={geometry.floor} material={mats.floor} position={FLOOR_POSITION} />
      <mesh geometry={geometry.ceiling} material={mats.flat} position={CEILING_POSITION} />
      <instancedMesh
        ref={piersRef}
        args={[undefined, undefined, MAX_PIERS]}
        geometry={geometry.pier}
        material={mats.pier}
        frustumCulled={false}
      />
      <instancedMesh
        ref={cansRef}
        args={[undefined, undefined, MAX_LAMPS]}
        geometry={geometry.can}
        material={mats.can}
        frustumCulled={false}
      />
      <instancedMesh
        ref={armsRef}
        args={[undefined, undefined, MAX_LAMPS]}
        geometry={geometry.arm}
        material={mats.fitting}
        frustumCulled={false}
      />
      <instancedMesh
        ref={platesRef}
        args={[undefined, undefined, MAX_LAMPS]}
        geometry={geometry.plate}
        material={mats.fitting}
        frustumCulled={false}
      />
    </group>
  );
}
