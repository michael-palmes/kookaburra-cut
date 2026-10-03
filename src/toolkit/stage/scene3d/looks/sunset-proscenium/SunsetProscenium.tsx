import { useLayoutEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, type IUniform, type ShaderMaterial } from "three";
import { useFormat } from "../../../../../engine/format";
import {
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  aspectCrown,
  PROSCENIUM_FLOOR_Y,
  prosceniumArrays,
  prosceniumRibs,
  RIB_DEPTH,
} from "./proscenium";
import { FLOOR_FRAGMENT, RIB_FRAGMENT, RIB_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_POSITION: [number, number, number] = [0, PROSCENIUM_FLOOR_Y, 0];
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const FLOOR_SIZE: [number, number] = [80, 80];
const DARK_LUMINANCE = 0.2;
/** The sketch's cove strength sits at the default slider value. */
const GLOW_DEFAULT = 0.8;
const ROSE_PERIOD = 72;

function shared(): Record<string, IUniform> {
  return {
    uBand: lookColorUniform("#1f2a3d"),
    uAlt: lookColorUniform("#654e62"),
    uBacking: lookColorUniform("#090b11"),
    uDark: { value: 1 },
  };
}

/** Sunset proscenium: a nest of stepped, squared deco arches behind the stage (and mirrored past the far side), each smaller and farther than the last, with a cove glow rising outward through the ribs. Unlit; one merged mesh plus a faint floor. */
export function SunsetProscenium({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const { aspect } = useFormat();
  const crown = aspectCrown(params.crown, aspect);
  const ribs = useMemo(
    () =>
      prosceniumRibs({
        ribs: params.ribs,
        setBack: params.setBack,
        innerWidth: params.innerWidth,
        crown,
      }),
    [params.ribs, params.setBack, params.innerWidth, crown],
  );
  const geometry = useMemo(() => {
    const arrays = prosceniumArrays(ribs);
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(arrays.position, 3));
    g.setAttribute("aRib", new BufferAttribute(arrays.rib, 3));
    g.setIndex(new BufferAttribute(arrays.index, 1));
    g.computeBoundingSphere();
    return g;
  }, [ribs]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const mats = useLookMaterials(
    () => ({
      ribs: {
        key: "sunset-proscenium/ribs",
        vertexShader: RIB_VERTEX,
        fragmentShader: RIB_FRAGMENT,
        uniforms: {
          ...shared(),
          uWarm: lookColorUniform("#a57a58"),
          uRose: lookColorUniform("#8a6670"),
          uPhase: { value: 0 },
          uRoseMix: { value: 0 },
          uRibs: { value: 7 },
          uSteps: { value: 3 },
          uGlow: { value: 1 },
        },
      },
      floor: {
        key: "sunset-proscenium/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { ...shared(), uInner: { value: 16 }, uDepth: { value: 17.4 } },
      },
    }),
    [],
  );
  const both = useMemo<ShaderMaterial[]>(() => [mats.ribs, mats.floor], [mats]);

  useLayoutEffect(() => {
    for (const m of both) {
      const u = m.uniforms;
      u.uBand.value.set(colors[0]);
      u.uAlt.value.set(colors[1]);
      u.uBacking.value.set(backing);
      u.uDark.value = lookLuminance(colors[0]) < DARK_LUMINANCE ? 1 : 0;
    }
    mats.ribs.uniforms.uWarm.value.set(colors[2]);
    mats.ribs.uniforms.uRose.value.set(colors[3]);
  }, [both, mats, colors[0], colors[1], colors[2], colors[3], backing]);

  useLayoutEffect(() => {
    const u = mats.ribs.uniforms;
    const rise = Math.max(params.riseSeconds, 1);
    u.uPhase.value = loopSeconds(t, rise) / rise;
    u.uRoseMix.value =
      0.5 - 0.5 * Math.cos((2 * Math.PI * loopSeconds(t, ROSE_PERIOD)) / ROSE_PERIOD);
    u.uRibs.value = ribs.length;
    u.uSteps.value = Math.round(params.steps);
    u.uGlow.value = params.glow / GLOW_DEFAULT;
    mats.floor.uniforms.uInner.value = ribs[0].halfWidth;
    mats.floor.uniforms.uDepth.value = RIB_DEPTH - ribs[0].z;
  }, [mats, t, ribs, params.riseSeconds, params.steps, params.glow]);

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={geometry} material={mats.ribs} />
      <mesh material={mats.floor} position={FLOOR_POSITION} rotation={FLOOR_ROTATION}>
        <planeGeometry args={FLOOR_SIZE} />
      </mesh>
    </group>
  );
}
