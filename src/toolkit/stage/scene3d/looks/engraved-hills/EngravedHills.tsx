import { useLayoutEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Vector2, Vector3 } from "three";
import {
  inkLoop,
  inkRasterSync,
  inkRibbonMaterial,
  lookColorUniform,
  lookLuminance,
  loopSeconds,
  skyDomeMaterial,
  useInkRibbonGeometry,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
  writeGoboSun,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import { HILL_RANGES, HILLS_PERIOD, HILLS_SUN, hillsData } from "./hills";
import {
  CREST_FRAGMENT,
  CREST_PATH,
  CREST_VERTEX_HOOK,
  CREST_WIDTH,
  LAND_FRAGMENT,
  LAND_VERTEX,
  SKY_FRAGMENT,
} from "./shaders";

const SKY_RADIUS = 190;

function landGeometry(): BufferGeometry {
  const data = hillsData();
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.positions, 3));
  g.setAttribute("hill", new BufferAttribute(data.hill, 3));
  g.setIndex(new BufferAttribute(data.index, 1));
  g.computeVertexNormals();
  return g;
}

function crestStrands() {
  const { crests } = hillsData();
  return HILL_RANGES.map((g, k) => {
    const pts: number[][] = [];
    for (let j = 0; j < crests[k].length / 4; j++)
      pts.push(Array.from(crests[k].subarray(j * 4, j * 4 + 4)));
    return inkLoop(pts, [g.px, g.aerial]);
  });
}

/** White line when the ink is lighter than the paper (dark presets print as a Bewick engraving), eased over a narrow band so a colour drag never pops. */
export function hillsInversion(inkLuminance: number, paperLuminance: number): number {
  const t = Math.min(1, Math.max(0, (inkLuminance - paperLuminance + 0.03) / 0.06));
  return t * t * (3 - 2 * t);
}

/** Engraved hills: a steel or copperplate book-plate view of rolling downs. Four ranges ring the stage on one static heightfield whose ruling follows the land and swells in shade under a swinging virtual sun; F2 crest outlines; a ruled F7 sky with ruled clouds turning round. Loops exactly at 240 s. */
export function EngravedHills({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const land = useMemo(landGeometry, []);
  useLayoutEffect(() => () => land.dispose(), [land]);
  const dome = useSkyDomeGeometry(SKY_RADIUS);
  const crests = useInkRibbonGeometry(crestStrands, []);

  const mats = useLookMaterials(() => {
    const shared = {
      uInv: { value: 1 },
      uPaper: lookColorUniform("#100f0d"),
      uSun: { value: new Vector3(1, 0, 0) },
      uCloudAngle: { value: 0 },
      uRange: { value: 1 },
    };
    const ink = lookColorUniform("#625c52");
    const far = lookColorUniform("#46463f");
    return {
      sky: skyDomeMaterial({
        key: "engraved-hills/sky",
        fragmentShader: SKY_FRAGMENT,
        uniforms: {
          ...shared,
          uSky: lookColorUniform("#434a53"),
          uInkRaster: { value: new Vector2() },
        },
      }),
      land: {
        key: "engraved-hills/land",
        vertexShader: LAND_VERTEX,
        fragmentShader: LAND_FRAGMENT,
        uniforms: {
          ...shared,
          uInk: ink,
          uFar: far,
          uPitch: { value: 9 },
          uSwell: { value: 1 },
          uCross: { value: 1 },
          uInkRaster: { value: new Vector2() },
        },
      },
      crest: inkRibbonMaterial({
        key: "engraved-hills/crest",
        path: CREST_PATH,
        width: CREST_WIDTH,
        vertex: CREST_VERTEX_HOOK,
        fragmentShader: CREST_FRAGMENT,
        uniforms: { ...shared, uInk: ink, uFar: far },
        lift: 0.012,
      }),
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.land.uniforms;
    u.uInk.value.set(colors[0]);
    u.uFar.value.set(colors[1]);
    mats.sky.uniforms.uSky.value.set(colors[2]);
    u.uPaper.value.set(backing);
    u.uInv.value = hillsInversion(lookLuminance(colors[0]), lookLuminance(backing));
  }, [mats, colors[0], colors[1], colors[2], backing]);

  useLayoutEffect(() => {
    const u = mats.land.uniforms;
    writeGoboSun(u.uSun.value, { ...HILLS_SUN, swayDeg: params.sunSwing }, t);
    u.uCloudAngle.value =
      (2 * Math.PI * loopSeconds(t * params.clouds, HILLS_PERIOD)) / HILLS_PERIOD;
    u.uRange.value = params.rangeHeight;
    u.uPitch.value = params.pitch;
    u.uSwell.value = params.swell;
    u.uCross.value = params.crossHatch;
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={dome} material={mats.sky} onBeforeRender={inkRasterSync} />
      <mesh
        geometry={land}
        material={mats.land}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh
        geometry={crests}
        material={mats.crest}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
