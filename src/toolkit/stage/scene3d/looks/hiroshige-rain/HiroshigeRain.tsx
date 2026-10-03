import { useLayoutEffect, useMemo } from "react";
import {
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Vector2,
} from "three";
import {
  inkLoop,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  loopSeconds,
  showInkStrands,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  RAIN_FALL_PERIOD,
  RAIN_FLOOR_Y,
  RAIN_HORIZON_RADIUS,
  RAIN_PUDDLE_PERIOD,
  RAIN_PUDDLE_SLOTS,
  rainPuddleSeeds,
  rainSlants,
  rainStrandCount,
  rainStrands,
} from "./rain";
import {
  HORIZON_FRAGMENT,
  PUDDLE_FRAGMENT,
  PUDDLE_VERTEX,
  STREAK_FRAGMENT,
  STREAK_PATH,
  STREAK_WIDTH,
} from "./shaders";

const TAU = Math.PI * 2;
const HORIZON_POINTS = 256;
/** Streak ink at full strength, near and far veils: the near veil leads, the far veil sits paler. */
const VEIL_INK = [0.7, 0.5] as const;

function puddleGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3),
  );
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.setAttribute("aSeed", new InstancedBufferAttribute(rainPuddleSeeds(), 4));
  g.instanceCount = 0;
  return g;
}

function horizonStrand() {
  const pts: number[][] = [];
  for (let i = 0; i < HORIZON_POINTS; i++) {
    const a = (i / HORIZON_POINTS) * TAU;
    pts.push([Math.cos(a) * RAIN_HORIZON_RADIUS, RAIN_FLOOR_Y, Math.sin(a) * RAIN_HORIZON_RADIUS]);
  }
  return [inkLoop(pts)];
}

/** Hiroshige rain: two veils of slanted drizzle crossing into a net (a sparse near veil leaning one way, a paler, denser far veil leaning the other), puddle rings opening on the floor and a faint horizon. Streaks are F2 ink strands placed in the vertex stage from the clock. */
export function HiroshigeRain({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const streaks = useInkRibbonGeometry(rainStrands, []);
  const horizon = useInkRibbonGeometry(horizonStrand, []);
  const puddles = useMemo(puddleGeometry, []);
  useLayoutEffect(() => () => puddles.dispose(), [puddles]);
  const slants = useMemo<[number, number]>(() => [0, 0], []);

  const mats = useLookMaterials(() => {
    const shared = { uBacking: lookColorUniform("#0e1216") };
    const puddle = lookColorUniform("#4b5963");
    return {
      puddle: {
        key: "hiroshige-rain/puddle",
        vertexShader: PUDDLE_VERTEX,
        fragmentShader: PUDDLE_FRAGMENT,
        transparent: true,
        uniforms: {
          ...shared,
          uPuddle: puddle,
          uPuddleTime: { value: 0 },
          uPuddleInk: { value: 0.8 },
        },
      },
      horizon: inkRibbonMaterial({
        key: "hiroshige-rain/horizon",
        fragmentShader: HORIZON_FRAGMENT,
        uniforms: { ...shared, uPuddle: puddle, uHorizonInk: { value: 0.45 } },
        lineWidth: { px: 1.4 },
      }),
      rain: inkRibbonMaterial({
        key: "hiroshige-rain/streak",
        path: STREAK_PATH,
        width: STREAK_WIDTH,
        fragmentShader: STREAK_FRAGMENT,
        uniforms: {
          ...shared,
          uNear: lookColorUniform("#56616c"),
          uFar: lookColorUniform("#3c464f"),
          uInk: { value: new Vector2(...VEIL_INK) },
          uFall: { value: 0 },
          uSlant: { value: new Vector2() },
        },
      }),
    };
  }, []);

  useLayoutEffect(() => {
    mats.rain.uniforms.uNear.value.set(colors[0]);
    mats.rain.uniforms.uFar.value.set(colors[1]);
    mats.puddle.uniforms.uPuddle.value.set(colors[2]);
    mats.puddle.uniforms.uBacking.value.set(backing);
  }, [mats, colors[0], colors[1], colors[2], backing]);

  const strands = rainStrandCount(params.density);
  const puddleCount = Math.round(RAIN_PUDDLE_SLOTS * Math.max(0, params.puddles));
  useLayoutEffect(() => {
    const rain = mats.rain.uniforms;
    rain.uFall.value = loopSeconds(t * params.fall, RAIN_FALL_PERIOD);
    rainSlants(t, params.nearSlant, params.farSlant, slants);
    (rain.uSlant.value as Vector2).set(slants[0], slants[1]);
    mats.puddle.uniforms.uPuddleTime.value = loopSeconds(t, RAIN_PUDDLE_PERIOD);
    mats.horizon.uniforms.uHorizonInk.value = 0.45 * params.horizon;
    showInkStrands(streaks, strands);
    puddles.instanceCount = puddleCount;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh
        geometry={puddles}
        material={mats.puddle}
        frustumCulled={false}
        visible={puddleCount > 0}
      />
      <mesh
        geometry={horizon}
        material={mats.horizon}
        frustumCulled={false}
        visible={params.horizon > 0}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={streaks}
        material={mats.rain}
        frustumCulled={false}
        visible={strands > 0}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
