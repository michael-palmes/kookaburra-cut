import { useLayoutEffect, useMemo } from "react";
import {
  CircleGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type IUniform,
  Sphere,
  Vector2,
  Vector3,
} from "three";
import {
  inkRasterSync,
  inkRibbonMaterial,
  inkStrands,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  smoothstep,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { GROVE, groveWands, gustPeriod, hazeWindow, type Wand } from "./grove";
import {
  GROUND_FRAGMENT,
  LANTERN_FRAGMENT,
  LANTERN_VERTEX,
  ROD_FRAGMENT,
  ROD_PATH,
  ROD_WIDTH,
} from "./shaders";

/** Rod width at the foot, in world units, before the taper. */
const ROD_WIDTH_WORLD = 0.2;
const GROUND_RADIUS = 80;
/** Every part shares one stage-centred bound, so the transparent sort ties and mount order is draw order. */
const BOUND = new Sphere(new Vector3(), GROUND_RADIUS);

/** One quad per lantern: foot, height and row in `aWand`, (sway cycles, phase, stiffness) in `aSway`. */
export function lanternGeometry(wands: readonly Wand[]): InstancedBufferGeometry {
  const aWand = new Float32Array(wands.length * 4);
  const aSway = new Float32Array(wands.length * 3);
  wands.forEach((w, i) => {
    aWand.set([w.x, w.z, w.height, w.row], i * 4);
    aSway.set([w.cycles, w.phase, w.stiffness], i * 3);
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
  );
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute("aWand", new InstancedBufferAttribute(aWand, 4));
  g.setAttribute("aSway", new InstancedBufferAttribute(aSway, 3));
  g.instanceCount = wands.length;
  g.boundingSphere = BOUND.clone();
  return g;
}

function groundGeometry(): CircleGeometry {
  const g = new CircleGeometry(GROUND_RADIUS, 96);
  g.rotateX(-Math.PI / 2);
  g.translate(0, GROVE.floorY, 0);
  g.boundingSphere = BOUND.clone();
  return g;
}

/** Wind wands: a planted grove of Len Lye kinetic rods (F2 ink strands, bent in the vertex stage) tipped with lantern beads, over a ground that settles into the backing. */
export function WindWands({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const wands = useMemo(() => groveWands(params.count, params.inner), [params.count, params.inner]);
  const rods = useInkRibbonGeometry(
    () =>
      inkStrands(
        wands.length,
        GROVE.segments + 1,
        (s, i) => [i / GROVE.segments, wands[s].cycles, wands[s].phase, wands[s].stiffness],
        { data: (s) => [wands[s].x, wands[s].z, wands[s].height, wands[s].row] },
      ),
    [wands],
  );
  rods.boundingSphere = BOUND;
  const lanterns = useMemo(() => lanternGeometry(wands), [wands]);
  const ground = useMemo(groundGeometry, []);
  useLayoutEffect(() => () => lanterns.dispose(), [lanterns]);
  useLayoutEffect(() => () => ground.dispose(), [ground]);

  const mats = useLookMaterials(() => {
    const bend: Record<string, IUniform> = {
      uTime: { value: 0 },
      uLean: { value: 0.1 },
      uSway: { value: 0.065 },
      uGustT: { value: 12 },
      uHeight: { value: 1 },
      uWand: lookColorUniform("#6a524a"),
    };
    return {
      ground: {
        key: "wind-wands/ground",
        fragmentShader: GROUND_FRAGMENT,
        uniforms: {
          uGround: lookColorUniform("#1c1715"),
          uBacking: lookColorUniform("#0c0a09"),
        },
      },
      rods: inkRibbonMaterial({
        key: "wind-wands/rods",
        path: ROD_PATH,
        width: ROD_WIDTH,
        fragmentShader: ROD_FRAGMENT,
        uniforms: {
          ...bend,
          uRodWidth: { value: ROD_WIDTH_WORLD },
          uHaze: { value: new Vector2() },
        },
        lineWidth: { min: 1.3 },
      }),
      lanterns: {
        key: "wind-wands/lanterns",
        vertexShader: LANTERN_VERTEX,
        fragmentShader: LANTERN_FRAGMENT,
        transparent: true,
        uniforms: { ...bend, uLantern: lookColorUniform("#b8844f"), uDark: { value: 1 } },
      },
    };
  }, []);

  useLayoutEffect(() => {
    mats.rods.uniforms.uWand.value.set(colors[0]);
    mats.lanterns.uniforms.uLantern.value.set(colors[1]);
    mats.ground.uniforms.uGround.value.set(colors[2]);
    mats.ground.uniforms.uBacking.value.set(backing);
    mats.lanterns.uniforms.uDark.value = 1 - smoothstep(0.08, 0.3, lookLuminance(backing));
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const u = mats.rods.uniforms;
    u.uTime.value = loopSeconds(t, GROVE.loop);
    u.uLean.value = params.lean;
    u.uSway.value = params.sway;
    u.uGustT.value = gustPeriod(params.gust);
    u.uHeight.value = params.height;
    const [lo, hi] = hazeWindow(params.haze);
    u.uHaze.value.set(lo, hi);
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={ground} material={mats.ground} frustumCulled={false} />
      <mesh
        geometry={rods}
        material={mats.rods}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh geometry={lanterns} material={mats.lanterns} frustumCulled={false} />
    </group>
  );
}
