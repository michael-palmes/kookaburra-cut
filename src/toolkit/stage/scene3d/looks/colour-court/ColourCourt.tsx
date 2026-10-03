import { useLayoutEffect, useMemo } from "react";
import {
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  type IUniform,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { lookColorUniform, loopSeconds, useLookMaterials, useLookTime } from "../../kit";
import { type GoboSunPath, writeGoboSun } from "../../kit/gobo";
import type { Scene3dLookProps } from "../../types";
import {
  COURT_FLOOR_Y,
  COURT_MAX_WALLS,
  COURT_WALL_THICKNESS,
  courtLayout,
  courtSunAzimuth,
} from "./court";
import { FLOOR_FRAGMENT, WALL_FRAGMENT, WALL_VERTEX } from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_RADIUS = 80;
const FLOOR_POSITION: [number, number, number] = [0, COURT_FLOOR_Y, 0];
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
/** The Rothko fields breathe on 40 and 60 s cycles, so their clock loops at 120 s. */
const FIELD_LOOP = 120;
const SHADE_SCALE = 0.82;
const FLOOR_TINT = 0.2;
const DEG = Math.PI / 180;

/** One unit box per wall, each carrying its wall index, so one material draws them all while three still sorts the walls back to front. */
function wallGeometries(): BoxGeometry[] {
  return Array.from({ length: COURT_MAX_WALLS }, (_, i) => {
    const g = new BoxGeometry(1, 1, 1);
    const n = g.getAttribute("position").count;
    g.setAttribute("aWall", new Float32BufferAttribute(new Float32Array(n).fill(i), 1));
    return g;
  });
}

/** Colour court: Barragan's freestanding colour walls round the stage in half-light, a virtual sun behind them sweeping long wall shadows across the floor, one high glowing slot whose light blade turns on the floor, and soft Rothko fields breathing on three faces. Unlit; every shadow is an analytic trace against the walls (F6). */
export function ColourCourt({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const seed = Math.round(params.layoutSeed);
  const count = Math.min(COURT_MAX_WALLS, Math.max(1, Math.round(params.walls)));
  const layout = useMemo(() => courtLayout(seed), [seed]);
  const poses = useMemo(
    () =>
      layout.map((wall) => ({
        position: [wall.x, COURT_FLOOR_Y + wall.height / 2, wall.z] as [number, number, number],
        rotation: [0, -wall.angleDeg * DEG, 0] as [number, number, number],
        scale: [wall.width, wall.height, COURT_WALL_THICKNESS] as [number, number, number],
      })),
    [layout],
  );
  const geometries = useMemo(wallGeometries, []);
  useLayoutEffect(
    () => () => {
      for (const g of geometries) g.dispose();
    },
    [geometries],
  );

  const mats = useLookMaterials(() => {
    const shared: Record<string, IUniform> = {
      uWallA: { value: Array.from({ length: COURT_MAX_WALLS }, () => new Vector4()) },
      uWallT: { value: Array.from({ length: COURT_MAX_WALLS }, () => new Vector2(1, 0)) },
      uWallCount: { value: 0 },
      uSun: { value: new Vector3(0, 1, 0) },
      uSlotCol: lookColorUniform("#000000"),
      uShade: lookColorUniform("#000000"),
      uFloor: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
      uTime: { value: 0 },
      uBladeAmount: { value: 0.34 },
    };
    return {
      wall: {
        key: "colour-court/wall",
        vertexShader: WALL_VERTEX,
        fragmentShader: WALL_FRAGMENT,
        transparent: true,
        depthWrite: true,
        uniforms: {
          ...shared,
          uRosa: lookColorUniform("#000000"),
          uOchre: lookColorUniform("#000000"),
          uJac: lookColorUniform("#000000"),
          uWallC: { value: Array.from({ length: COURT_MAX_WALLS }, () => new Vector2()) },
          uFields: { value: 0.35 },
        },
      },
      floor: { key: "colour-court/floor", fragmentShader: FLOOR_FRAGMENT, uniforms: shared },
    };
  }, []);

  const [rosa, ochre, jac, slot] = colors;
  useLayoutEffect(() => {
    const w = mats.wall.uniforms;
    w.uRosa.value.set(rosa);
    w.uOchre.value.set(ochre);
    w.uJac.value.set(jac);
    w.uSlotCol.value.set(slot);
    w.uBacking.value.set(backing);
    (w.uShade.value as Color).set(jac).multiplyScalar(SHADE_SCALE);
    const mean = new Color(rosa)
      .add(new Color(ochre))
      .add(new Color(jac))
      .multiplyScalar(1 / 3);
    (w.uFloor.value as Color).set(backing).lerp(mean, FLOOR_TINT);
  }, [mats, rosa, ochre, jac, slot, backing]);

  useLayoutEffect(() => {
    const w = mats.wall.uniforms;
    layout.forEach((wall, i) => {
      const a = wall.angleDeg * DEG;
      w.uWallA.value[i].set(wall.x, wall.z, wall.width / 2, wall.height);
      w.uWallT.value[i].set(Math.cos(a), Math.sin(a));
      w.uWallC.value[i].set(wall.colour, wall.fields ? 1 : 0);
    });
    w.uWallCount.value = count;
  }, [mats, layout, count]);

  const sun = useMemo<GoboSunPath>(
    () => ({
      azimuthDeg: courtSunAzimuth(seed),
      elevationDeg: params.sunElevation,
      swayDeg: params.sunSwing,
      periodS: params.dayLength,
    }),
    [seed, params.sunElevation, params.sunSwing, params.dayLength],
  );
  useLayoutEffect(() => {
    const w = mats.wall.uniforms;
    writeGoboSun(w.uSun.value, sun, t);
    w.uTime.value = loopSeconds(t, FIELD_LOOP);
    w.uBladeAmount.value = params.blade;
    w.uFields.value = params.fields;
  }, [mats, sun, t, params.blade, params.fields]);

  return (
    <group userData={ROOT_DATA}>
      {poses.map((pose, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: walls are fixed slots in layout order.
          key={i}
          geometry={geometries[i]}
          material={mats.wall}
          visible={i < count}
          position={pose.position}
          rotation={pose.rotation}
          scale={pose.scale}
        />
      ))}
      <mesh material={mats.floor} position={FLOOR_POSITION} rotation={FLOOR_ROTATION}>
        <circleGeometry args={[FLOOR_RADIUS, 96]} />
      </mesh>
    </group>
  );
}
