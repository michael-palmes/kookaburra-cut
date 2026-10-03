import { useLayoutEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type IUniform,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  inkPolyline,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  CLOUD_FRAGMENT,
  CLOUD_VERTEX,
  FLAT_FRAGMENT,
  FLAT_VERTEX,
  FLOOR_FRAGMENT,
  SUN_FRAGMENT,
  SUN_VERTEX,
  WIRE_FRAGMENT,
  WIRE_PATH,
} from "./shaders";
import {
  THEATRE_FLOOR_Y,
  THEATRE_LAMP,
  THEATRE_MAX_RINGS,
  THEATRE_ROCK_LOOP_S,
  THEATRE_SUN,
  theatreCasters,
  theatreCloudQuads,
  theatreCloudTurn,
  theatreLayout,
  theatreStepTime,
  theatreSunAzimuth,
  theatreSunTurn,
  theatreVisibleRings,
  theatreWires,
} from "./theatre";

const DEG = Math.PI / 180;
const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, THEATRE_FLOOR_Y, 0];
/** A backing darker than this reads as a night stage: the disc becomes a moon and cut edges catch the near card instead of the paper. */
const DARK_BACKING = 0.18;
const RIM = { light: [0.75, 0.7, 0.55, 0.35, 0.3], dark: [0.9, 0.6, 0.35, 0.15, 0.1] } as const;
/** Display-space haze toward the backing per ring, so far cards step back (dark cards most). */
const HAZE = { light: [0, 0.03, 0.06, 0.1, 0.18], dark: [0, 0.1, 0.2, 0.3, 0.42] } as const;
/** The sketch's drop shadow strength at the default Shadow slider. */
const SHADOW_GAIN = 0.6 / 0.55;

function quads(attrs: Record<string, [Float32Array, number]>, index: Uint16Array): BufferGeometry {
  const g = new BufferGeometry();
  for (const [name, [data, size]] of Object.entries(attrs)) {
    g.setAttribute(name, new BufferAttribute(data, size));
  }
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}

function createParts() {
  const { flats, clouds } = theatreLayout();
  const c = theatreCloudQuads(clouds);
  const sun = new PlaneGeometry(THEATRE_SUN.size * 2, THEATRE_SUN.size * 2);
  sun.translate(0, THEATRE_SUN.y, -THEATRE_SUN.distance);
  return {
    clouds,
    flats: quads(
      {
        position: [flats.position, 3],
        aPivot: [flats.pivot, 4],
        aInfo: [flats.info, 4],
      },
      flats.index,
    ),
    cloudCards: quads(
      {
        position: [c.position, 3],
        aPivot: [c.pivot, 4],
        aInfo: [c.info, 4],
        aLocal: [c.local, 2],
      },
      c.index,
    ),
    sun,
    floor: new PlaneGeometry(180, 180),
  };
}

function sharedUniforms(): Record<string, IUniform> {
  return {
    uFlatH: { value: 1 },
    uTrees: { value: 0.78 },
    uRingOn: { value: new Float32Array(THEATRE_MAX_RINGS) },
    uPrev: { value: new Float32Array(THEATRE_MAX_RINGS) },
    uLamp: { value: new Vector3(0, THEATRE_LAMP.y, -THEATRE_LAMP.offset) },
    uRockTime: { value: 0 },
    uRock: { value: 1.8 * DEG },
    uCloudTurn: { value: 0 },
    uSunTurn: { value: 0 },
  };
}

const ringColours = () => Array.from({ length: THEATRE_MAX_RINGS }, () => new Color());
const scratch = {
  near: new Color(),
  mid: new Color(),
  far: new Color(),
  paper: new Color(),
  back: new Color(),
};

/** Paper theatre: concentric rings of painted card flats (hills, a tree row, ranges and far peaks) rocking on their sticks, card clouds sliding round on fly wires and a paper sun or moon on a brass wire. Unlit: every card shades itself from a virtual footlight near the stage, which throws soft drop shadows onto the next ring and the board floor. */
export function PaperTheatre({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const parts = useMemo(createParts, []);
  useLayoutEffect(
    () => () => {
      for (const g of [parts.flats, parts.cloudCards, parts.sun, parts.floor]) g.dispose();
    },
    [parts],
  );
  const wires = useInkRibbonGeometry(
    () =>
      theatreWires(parts.clouds).map(([x0, y0, z0, x1, y1, z1, kind]) =>
        inkPolyline(
          [
            [x0, y0, z0],
            [x1, y1, z1],
          ],
          [kind],
        ),
      ),
    [parts],
  );

  const mats = useLookMaterials(() => {
    const shared = sharedUniforms();
    const backingU = lookColorUniform("#0a0d15");
    const shade = { value: 0.7 };
    const shadeAmt = { value: 0.6 };
    return {
      flats: {
        key: "paper-theatre/flats",
        vertexShader: FLAT_VERTEX,
        fragmentShader: FLAT_FRAGMENT,
        side: DoubleSide,
        alphaToCoverage: true,
        uniforms: {
          ...shared,
          uCols: { value: ringColours() },
          uEdges: { value: ringColours() },
          uHaze: { value: new Float32Array(THEATRE_MAX_RINGS) },
          uBackCol: lookColorUniform("#27333f"),
          uBacking: backingU,
          uShade: shade,
          uShadeAmt: shadeAmt,
        },
      },
      clouds: {
        key: "paper-theatre/clouds",
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        side: DoubleSide,
        alphaToCoverage: true,
        uniforms: {
          ...shared,
          uCloud: lookColorUniform("#161d29"),
          uCloudEdge: lookColorUniform("#27333f"),
        },
      },
      sun: {
        key: "paper-theatre/sun",
        vertexShader: SUN_VERTEX,
        fragmentShader: SUN_FRAGMENT,
        side: DoubleSide,
        alphaToCoverage: true,
        uniforms: {
          ...shared,
          uSun: lookColorUniform("#9f926b"),
          uSunEdge: lookColorUniform("#9f926b"),
          uSunDim: lookColorUniform("#9f926b"),
          uMoon: { value: 1 },
        },
      },
      floor: {
        key: "paper-theatre/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: {
          ...shared,
          uFloor: lookColorUniform("#0a0d15"),
          uSeam: lookColorUniform("#0a0d15"),
          uBacking: backingU,
          uShade: shade,
          uShadeAmt: shadeAmt,
        },
      },
      wires: inkRibbonMaterial({
        key: "paper-theatre/wires",
        path: WIRE_PATH,
        fragmentShader: WIRE_FRAGMENT,
        lineWidth: { px: 1.4 },
        uniforms: {
          ...shared,
          uWire: lookColorUniform("#27333f"),
          uBrass: lookColorUniform("#9f926b"),
          uWireAlpha: { value: 0.6 },
        },
      }),
    };
  }, []);

  const [near, mid, far, sun] = colors;
  useLayoutEffect(() => {
    const n = scratch.near.set(near);
    const m = scratch.mid.set(mid);
    const f = scratch.far.set(far);
    const back = scratch.back.set(backing);
    const dark = lookLuminance(backing) < DARK_BACKING;
    const paper = dark ? scratch.paper.copy(n).multiplyScalar(1.2) : scratch.paper.copy(back);
    const fl = mats.flats.uniforms;
    const cols = fl.uCols.value as Color[];
    const edges = fl.uEdges.value as Color[];
    const haze = fl.uHaze.value as Float32Array;
    cols[0].copy(n);
    cols[1].copy(n).lerp(m, 0.5);
    cols[2].copy(m);
    cols[3].copy(f).lerp(m, dark ? 0.15 : 0.1);
    cols[4].copy(f);
    const rim = dark ? RIM.dark : RIM.light;
    for (let k = 0; k < THEATRE_MAX_RINGS; k++) {
      edges[k].copy(cols[k]).lerp(paper, rim[k]);
      haze[k] = (dark ? HAZE.dark : HAZE.light)[k];
    }
    fl.uBackCol.value.copy(m).lerp(paper, 0.4);
    fl.uBacking.value.set(backing);
    fl.uShade.value = dark ? 0.45 : 0.7;
    const cl = mats.clouds.uniforms;
    cl.uCloud.value.copy(cols[3]).lerp(edges[3], 0.45);
    cl.uCloudEdge.value.copy(edges[3]);
    const s = mats.sun.uniforms;
    s.uSun.value.set(sun);
    s.uSunEdge.value.set(sun).lerp(paper, 0.5);
    s.uSunDim.value.set(sun).lerp(back, 0.55);
    s.uMoon.value = dark ? 1 : 0;
    const fo = mats.floor.uniforms;
    fo.uFloor.value.copy(back).lerp(m, dark ? 0.35 : 0.3);
    fo.uSeam.value.copy(back).lerp(n, dark ? 0.5 : 0.45);
    const w = mats.wires.uniforms;
    w.uWire.value.copy(m).lerp(paper, dark ? 0.1 : 0.25);
    w.uBrass.value.copy(n).lerp(s.uSun.value, 0.45);
  }, [mats, near, mid, far, sun, backing]);

  const visible = useMemo(() => theatreVisibleRings(params.rings), [params.rings]);
  useLayoutEffect(() => {
    const u = mats.flats.uniforms;
    const on = u.uRingOn.value as Float32Array;
    for (let k = 0; k < THEATRE_MAX_RINGS; k++) on[k] = visible.includes(k) ? 1 : 0;
    theatreCasters(visible, u.uPrev.value as Float32Array);
    const ts = theatreStepTime(t, params.stopMotion);
    const az = theatreSunAzimuth(ts);
    u.uFlatH.value = params.flatHeight;
    u.uTrees.value = params.treeDensity;
    u.uRock.value = params.rock * DEG;
    u.uRockTime.value = loopSeconds(ts, THEATRE_ROCK_LOOP_S);
    u.uCloudTurn.value = theatreCloudTurn(ts, params.cloudSpeed);
    u.uSunTurn.value = theatreSunTurn(az);
    (u.uLamp.value as Vector3).set(
      THEATRE_LAMP.offset * Math.sin(az * DEG),
      THEATRE_LAMP.y,
      THEATRE_LAMP.offset * Math.cos(az * DEG),
    );
    mats.flats.uniforms.uShadeAmt.value = params.shadow * SHADOW_GAIN;
  });

  return (
    <group userData={ROOT_DATA}>
      <mesh
        geometry={parts.floor}
        material={mats.floor}
        position={FLOOR_POSITION}
        rotation={FLOOR_ROTATION}
        frustumCulled={false}
      />
      <mesh geometry={parts.flats} material={mats.flats} frustumCulled={false} />
      <mesh geometry={parts.cloudCards} material={mats.clouds} frustumCulled={false} />
      <mesh geometry={parts.sun} material={mats.sun} frustumCulled={false} />
      <mesh
        geometry={wires}
        material={mats.wires}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
