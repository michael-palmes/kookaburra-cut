import { useLayoutEffect, useMemo } from "react";
import {
  BackSide,
  type BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  type IUniform,
  Sphere,
  Vector3,
} from "three";
import { useTimeline } from "../../../../../engine/timeline";
import {
  inkRasterSync,
  inkRibbonGeometry,
  inkRibbonMaterial,
  lookColorUniform,
  loopSeconds,
  SKY_DOME_RADIUS,
  skyDomeMaterial,
  useLookMaterials,
  useLookTime,
  useSkyDomeGeometry,
} from "../../kit";
import type { Scene3dLookProps } from "../../types";
import {
  GROUND_Y,
  HUMMOCKS,
  type LaceRing,
  lacePlantCount,
  laceRing,
  laceStepSeconds,
  lampDirection,
  placeLace,
} from "./lace";
import {
  DOME_FRAGMENT,
  FLOOR_FRAGMENT,
  HUMMOCK_FRAGMENT,
  LACE_FRAGMENT,
  LACE_PATH,
  LACE_WIDTH,
} from "./shaders";

/** Shadow lace: Lotte Reiniger backlit silhouettes. A glowing shell (its outer colour is the backing) with a lamp low on the horizon, a dark floor, two rings of seeded silhouette plants and hummocks, and boughs hanging in from above, all swaying on stop-motion steps. Every part after the opaque shell is transparent with depth writes off and a stage-centred bounding sphere, so mount order (far to near) is draw order. */

const RINGS: readonly LaceRing[] = ["far", "boughs", "near"];
/** Boughs swing more than the plants standing on the floor. */
const BOUGH_SWAY = 1.6;
const HUMMOCK_HEIGHT = 1;
const HALO_BREATH = 20;
const DEG = Math.PI / 180;

interface LaceMesh {
  geometry: ReturnType<typeof inkRibbonGeometry>;
  /** Ribbon segments after each strand, and strands after each plant. */
  segmentEnds: number[];
  plantEnds: number[];
}

const centred = <T extends BufferGeometry>(g: T, radius: number): T => {
  g.boundingSphere = new Sphere(new Vector3(), radius);
  return g;
};

function createParts() {
  const plants = placeLace();
  const lace = Object.fromEntries(
    RINGS.map((ring) => {
      const { strands, plantEnds } = laceRing(plants, ring);
      const geometry = centred(inkRibbonGeometry(strands), SKY_DOME_RADIUS);
      const segmentEnds = geometry.userData.inkStrandEnds as number[];
      return [ring, { geometry, segmentEnds, plantEnds }];
    }),
  ) as Record<LaceRing, LaceMesh>;
  const floor = new CircleGeometry(SKY_DOME_RADIUS - 1, 128);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, GROUND_Y, 0);
  const hummocks = HUMMOCKS.map((h) => {
    const g = new CylinderGeometry(h.radius, h.radius, HUMMOCK_HEIGHT, 256, 1, true);
    g.translate(0, GROUND_Y + HUMMOCK_HEIGHT / 2 - 0.02, 0);
    return centred(g, SKY_DOME_RADIUS);
  });
  return { lace, floor: centred(floor, SKY_DOME_RADIUS), hummocks };
}

export function ShadowLace({ colors, params, speed, backing }: Scene3dLookProps) {
  const t = useLookTime(speed);
  const { globalMs } = useTimeline();
  const stepT = laceStepSeconds(globalMs, params.stepFps, speed);
  const lampDir = useMemo(() => lampDirection(params.lampAzimuth), [params.lampAzimuth]);
  const dome = useSkyDomeGeometry();
  const parts = useMemo(createParts, []);
  useLayoutEffect(
    () => () => {
      for (const r of Object.values(parts.lace)) r.geometry.dispose();
      parts.floor.dispose();
      for (const g of parts.hummocks) g.dispose();
    },
    [parts],
  );

  const mats = useLookMaterials(() => {
    const shell: Record<string, IUniform> = {
      uIn: lookColorUniform("#000000"),
      uBacking: lookColorUniform("#000000"),
      uLampDir: { value: new Vector3(0, 0, -1) },
      uPulse: { value: 1 },
    };
    const sway = { uStepT: { value: 0 }, uHeight: { value: 1 } };
    const sil = lookColorUniform("#000000");
    const far = { value: new Color() };
    const lace = (ink: IUniform) =>
      inkRibbonMaterial({
        key: "shadow-lace/lace",
        path: LACE_PATH,
        width: LACE_WIDTH,
        fragmentShader: LACE_FRAGMENT,
        uniforms: { ...sway, uInk: ink, uSway: { value: 0 } },
        lineWidth: { min: 1.1 },
      });
    const hummock = (ink: IUniform, radius: number, seed: number) => ({
      key: "shadow-lace/hummock",
      fragmentShader: HUMMOCK_FRAGMENT,
      transparent: true,
      side: BackSide,
      uniforms: {
        uInk: ink,
        uRadius: { value: radius },
        uSeed: { value: seed },
        uHeight: sway.uHeight,
      },
    });
    return {
      dome: skyDomeMaterial({
        key: "shadow-lace/dome",
        fragmentShader: DOME_FRAGMENT,
        uniforms: { ...shell, uLamp: lookColorUniform("#000000"), uGrain: { value: 0.35 } },
      }),
      floor: {
        key: "shadow-lace/floor",
        fragmentShader: FLOOR_FRAGMENT,
        transparent: true,
        uniforms: { ...shell, uSil: sil },
      },
      far: lace(far),
      farHummock: hummock(far, HUMMOCKS[0].radius, HUMMOCKS[0].seed),
      boughs: lace(sil),
      nearHummock: hummock(sil, HUMMOCKS[1].radius, HUMMOCKS[1].seed),
      near: lace(sil),
    };
  }, []);

  useLayoutEffect(() => {
    const u = mats.floor.uniforms;
    u.uSil.value.set(colors[0]);
    u.uIn.value.set(colors[1]);
    mats.dome.uniforms.uLamp.value.set(colors[2]);
    u.uBacking.value.set(backing);
    const glow = new Color().lerpColors(u.uBacking.value, u.uIn.value, 0.5);
    mats.far.uniforms.uInk.value.lerpColors(u.uSil.value, glow, params.farTint);
  }, [mats, colors[0], colors[1], colors[2], backing, params.farTint]);

  useLayoutEffect(() => {
    const u = mats.floor.uniforms;
    u.uLampDir.value.set(lampDir[0], lampDir[1], lampDir[2]);
    u.uPulse.value =
      0.85 + 0.15 * Math.sin((2 * Math.PI * loopSeconds(t, HALO_BREATH)) / HALO_BREATH);
    mats.dome.uniforms.uGrain.value = params.grain;
    const sway = params.sway * DEG;
    mats.far.uniforms.uStepT.value = stepT;
    mats.far.uniforms.uHeight.value = params.plantHeight;
    mats.far.uniforms.uSway.value = sway;
    mats.near.uniforms.uSway.value = sway;
    mats.boughs.uniforms.uSway.value = sway * BOUGH_SWAY;
    for (const ring of RINGS) {
      const { geometry, segmentEnds, plantEnds } = parts.lace[ring];
      const plants = lacePlantCount(ring, params.density);
      geometry.instanceCount = plants > 0 ? segmentEnds[plantEnds[plants - 1] - 1] : 0;
    }
  });

  return (
    <group userData={{ kookaburraBg3d: true }}>
      <mesh geometry={dome} material={mats.dome} />
      <mesh geometry={parts.floor} material={mats.floor} frustumCulled={false} />
      <mesh
        geometry={parts.lace.far.geometry}
        material={mats.far}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh geometry={parts.hummocks[0]} material={mats.farHummock} frustumCulled={false} />
      <mesh
        geometry={parts.lace.boughs.geometry}
        material={mats.boughs}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
      <mesh geometry={parts.hummocks[1]} material={mats.nearHummock} frustumCulled={false} />
      <mesh
        geometry={parts.lace.near.geometry}
        material={mats.near}
        frustumCulled={false}
        onBeforeRender={inkRasterSync}
      />
    </group>
  );
}
