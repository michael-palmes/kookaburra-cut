import { useLayoutEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type IUniform,
  PlaneGeometry,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import {
  lookColorUniform,
  lookLuminance,
  useLookMaterials,
  useLookTime,
  writeGoboSun,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { FLOOR_FRAGMENT, PIECE_FRAGMENT, PIECE_VERTEX } from "./shaders";
import {
  TERRACE_FLOOR_Y,
  terraceGeometry,
  terraceHouseUniforms,
  terraceStreet,
  terraceSun,
  terraceWavePhase,
  terraceWidthScale,
} from "./terrace";

const ROOT_DATA = { kookaburraBg3d: true };
const FLOOR_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const FLOOR_POSITION: [number, number, number] = [0, TERRACE_FLOOR_Y, 0];
const DARK_BACKING = 0.18;

function createParts() {
  const { houses, unitVariant } = terraceStreet();
  const g = terraceGeometry(houses, unitVariant);
  const pieces = new BufferGeometry();
  pieces.setAttribute("position", new BufferAttribute(g.position, 3));
  pieces.setAttribute("aMeta", new BufferAttribute(g.meta, 4));
  pieces.setAttribute("aFace", new BufferAttribute(g.face, 4));
  pieces.setIndex(new BufferAttribute(g.index, 1));
  return { houses, unitVariant, pieces, floor: new PlaneGeometry(200, 200) };
}

function uniforms(houses: ReturnType<typeof terraceHouseUniforms>, variants: number[]) {
  const shared: Record<string, IUniform> = {
    uHA: { value: houses.a.map((h) => new Vector4(...h)) },
    uHB: { value: houses.b.map((h) => new Vector4(...h)) },
    uVar: { value: Float32Array.from(variants) },
    uRadius: { value: 12.5 },
    uUnits: { value: 12 },
    uSX: { value: 1 },
    uSA: { value: 1 },
    uWave: { value: 0 },
    uCrests: { value: 3 },
    uOpenTop: { value: 0.72 },
    uSun: { value: new Vector3(0, 0.4, 0.9) },
    uLit: lookColorUniform("#686054"),
    uShadeC: lookColorUniform("#2d3042"),
    uCrease: lookColorUniform("#131420"),
    uSheet: lookColorUniform("#2d3042"),
    uShadowC: lookColorUniform("#131420"),
    uTable: lookColorUniform("#131420"),
    uBacking: lookColorUniform("#1a1c28"),
    uShadowAmt: { value: 0.7 },
  };
  return shared;
}

const scratch = { lit: new Color(), shade: new Color(), crease: new Color(), back: new Color() };

/** Pop-up terrace: origamic architecture round the stage. Each unit is a back page with cut windows and a street of stepped terraces, arcades and gabled houses that fold up out of a pale card floor over matching holes, exact 90 degree fold kinematics in the vertex stage, in a slow wave round the ring. Unlit: facets shade and cast analytic sun shadows from a virtual sun low on the front left. */
export function PopUpTerrace({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const parts = useMemo(createParts, []);
  useLayoutEffect(
    () => () => {
      parts.pieces.dispose();
      parts.floor.dispose();
    },
    [parts],
  );
  const mats = useLookMaterials(() => {
    const shared = uniforms(terraceHouseUniforms(parts.houses), parts.unitVariant);
    return {
      pieces: {
        key: "pop-up-terrace/pieces",
        vertexShader: PIECE_VERTEX,
        fragmentShader: PIECE_FRAGMENT,
        side: DoubleSide,
        alphaToCoverage: true,
        uniforms: shared,
      },
      floor: {
        key: "pop-up-terrace/floor",
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { ...shared, uFade: { value: new Vector2(26, 70) } },
      },
    };
  }, [parts]);

  const [lit, shade, crease] = colors;
  useLayoutEffect(() => {
    const l = scratch.lit.set(lit);
    const s = scratch.shade.set(shade);
    const c = scratch.crease.set(crease);
    const back = scratch.back.set(backing);
    const dark = lookLuminance(backing) < DARK_BACKING;
    const u = mats.pieces.uniforms;
    u.uLit.value.copy(l);
    u.uShadeC.value.copy(s);
    u.uCrease.value.copy(c);
    u.uSheet.value.copy(s).lerp(l, dark ? 0.35 : 0.6);
    u.uShadowC.value.copy(s).lerp(c, dark ? 0.3 : 0.85);
    if (dark) u.uTable.value.copy(back).lerp(c, 0.4);
    else u.uTable.value.copy(c).lerp(back, 0.15);
    u.uBacking.value.copy(back);
    (mats.floor.uniforms.uFade.value as Vector2).set(dark ? 16 : 26, dark ? 42 : 70);
  }, [mats, lit, shade, crease, backing]);

  const sun = useMemo(() => terraceSun(params.sunAzimuth), [params.sunAzimuth]);
  useLayoutEffect(() => {
    const u = mats.pieces.uniforms;
    const units = Math.round(params.units);
    u.uRadius.value = params.radius;
    u.uUnits.value = units;
    u.uSX.value = terraceWidthScale(params.radius, units);
    u.uSA.value = params.height;
    u.uWave.value = terraceWavePhase(t, params.wavePeriod);
    u.uCrests.value = Math.round(params.crests);
    u.uOpenTop.value = Math.cos(Math.PI * Math.min(0.95, Math.max(0.02, params.openHold)));
    u.uShadowAmt.value = params.shadow;
    writeGoboSun(u.uSun.value as Vector3, sun, t);
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
      <mesh geometry={parts.pieces} material={mats.pieces} frustumCulled={false} />
    </group>
  );
}
