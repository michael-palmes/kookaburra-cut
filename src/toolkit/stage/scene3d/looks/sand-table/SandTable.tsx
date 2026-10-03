import { useLayoutEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  type Mesh,
  Sphere,
  SphereGeometry,
  Vector3,
} from "three";
import {
  createDishDiscGeometry,
  DISH_FLOOR_VERTEX_SHADER,
  dishHeight,
  lookColorUniform,
  lookLuminance,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  SAND,
  SAND_SEGMENTS,
  sandBallTime,
  sandCut,
  sandDishShape,
  sandPath,
  sandRose,
  writeSandSun,
} from "./rose";
import {
  BALL_FRAGMENT,
  BALL_VERTEX,
  FLOOR_FRAGMENT,
  RIBBON_FRAGMENT,
  RIBBON_VERTEX,
} from "./shaders";

const ROOT_DATA = { kookaburraBg3d: true };
const LIGHT_BACKING = 0.2;
const BOUNDS = new Sphere(new Vector3(0, 0, 0), SAND.dishRadius);

/** The whole loop's groove ribbon as two geometries over one buffer: (path fraction, side) per vertex, faces up. Older and newer draw ranges keep the newest groove on top across the loop seam. */
function ribbonGeometries(): [BufferGeometry, BufferGeometry] {
  const n = SAND_SEGMENTS;
  const pos = new Float32Array((n + 1) * 2 * 3);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pos.set([u, -1, 0, u, 1, 0], i * 6);
  }
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const position = new Float32BufferAttribute(pos, 3);
  const index = new BufferAttribute(idx, 1);
  const make = () => {
    const g = new BufferGeometry();
    g.setAttribute("position", position);
    g.setIndex(index);
    g.boundingSphere = BOUNDS.clone();
    return g;
  };
  return [make(), make()];
}

/** Sand table: a Sisyphus sand dish where a steel ball ploughs a precessing rose of six-groove raked bands. The loop is one ribbon built once with path time per vertex; grooves show while younger than the memory and relax flat. A virtual sun swings 40 degrees each way every 40 s, so groove light shifts even with the ball off screen. The dish rises past the grooves so a level camera sees the far bands face on. Unlit. */
export function SandTable({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const ballRef = useRef<Mesh>(null);
  const disc = useMemo(() => createDishDiscGeometry(48, 192, SAND.dishRadius), []);
  const [older, newer] = useMemo(ribbonGeometries, []);
  const ball = useMemo(() => new SphereGeometry(SAND.ballRadius, 24, 16), []);
  useLayoutEffect(
    () => () => {
      disc.dispose();
      older.dispose();
      newer.dispose();
      ball.dispose();
    },
    [disc, older, newer, ball],
  );

  const mats = useLookMaterials(() => {
    const shared = {
      uSand: lookColorUniform("#2a251e"),
      uGroove: lookColorUniform("#16130f"),
      uRidge: lookColorUniform("#635747"),
      uBacking: lookColorUniform("#110f0c"),
      uSun: { value: new Vector3(0, 1, 0) },
      uBall: { value: new Vector3() },
      uFadeStart: { value: 34 },
      uFadeEnd: { value: 46 },
      uDish: { value: new Vector3(SAND.dishStart, SAND.dishSpan, 0) },
    };
    return {
      floor: {
        key: "sand-table/floor",
        vertexShader: DISH_FLOOR_VERTEX_SHADER,
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { ...shared, uDiscRadius: { value: 47 }, uFloorY: { value: SAND.floorY } },
      },
      ribbon: {
        key: "sand-table/grooves",
        vertexShader: RIBBON_VERTEX,
        fragmentShader: RIBBON_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          ...shared,
          uClear: { value: 7.5 },
          uReach: { value: 29 },
          uPetals: { value: 25 },
          uHalfWidth: { value: SAND.halfWidth },
          uTm: { value: 0 },
          uMemory: { value: 1500 },
          uGrooves: { value: 6 },
          uBandSign: { value: 1 },
        },
      },
      ball: {
        key: "sand-table/ball",
        vertexShader: BALL_VERTEX,
        fragmentShader: BALL_FRAGMENT,
        uniforms: {
          uSun: shared.uSun,
          uBacking: shared.uBacking,
          uFadeStart: shared.uFadeStart,
          uFadeEnd: shared.uFadeEnd,
          uSteel: lookColorUniform("#4c5257"),
          uDark: lookColorUniform("#16130f"),
          uShine: lookColorUniform("#635747"),
        },
      },
    };
  }, []);

  useLayoutEffect(() => {
    const f = mats.floor.uniforms;
    f.uSand.value.set(colors[0]);
    f.uGroove.value.set(colors[1]);
    f.uRidge.value.set(colors[2]);
    f.uBacking.value.set(backing);
    const light = lookLuminance(backing) > LIGHT_BACKING;
    mats.ribbon.uniforms.uBandSign.value = light ? -1 : 1;
    const b = mats.ball.uniforms;
    b.uSteel.value.set(colors[3]);
    b.uDark.value.set(colors[1]);
    b.uShine.value.set(colors[2]);
  }, [mats, colors[0], colors[1], colors[2], colors[3], backing]);

  const rose = useMemo(
    () => sandRose(params.clearRadius, params.reach, params.petals),
    [params.clearRadius, params.reach, params.petals],
  );
  const dish = useMemo(() => sandDishShape(params.rise), [params.rise]);
  const ballXz = useMemo<[number, number]>(() => [0, 0], []);
  const tm = sandBallTime(t);

  useLayoutEffect(() => {
    const cut = sandCut(tm);
    older.setDrawRange(cut * 6, (SAND_SEGMENTS - cut) * 6);
    newer.setDrawRange(0, cut * 6);
    const f = mats.floor.uniforms;
    const fadeStart = rose.reach + 5;
    const fadeEnd = rose.reach + 17;
    f.uFadeStart.value = fadeStart;
    f.uFadeEnd.value = fadeEnd;
    f.uDiscRadius.value = fadeEnd + 1;
    f.uDish.value.set(dish.start, dish.span, dish.rise);
    writeSandSun(f.uSun.value, t, params.sunSwing, params.sunHeight);
    const g = mats.ribbon.uniforms;
    g.uClear.value = rose.clear;
    g.uReach.value = rose.reach;
    g.uPetals.value = rose.petals;
    g.uTm.value = tm;
    g.uMemory.value = params.memory;
    g.uGrooves.value = Math.round(params.grooves);
    const [x, z] = sandPath(tm, rose, ballXz);
    const y =
      SAND.floorY + dishHeight(Math.hypot(x, z), dish) + SAND.ballRadius * (1 - SAND.ballSink);
    f.uBall.value.set(x, y, z);
    ballRef.current?.position.set(x, y, z);
  });

  return (
    <group userData={ROOT_DATA}>
      <mesh geometry={disc} material={mats.floor} frustumCulled={false} />
      <mesh geometry={older} material={mats.ribbon} frustumCulled={false} />
      <mesh geometry={newer} material={mats.ribbon} frustumCulled={false} />
      <mesh ref={ballRef} geometry={ball} material={mats.ball} frustumCulled={false} />
    </group>
  );
}
