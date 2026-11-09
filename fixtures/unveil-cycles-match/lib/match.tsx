import {
  VolumetricSpot,
  type VolumetricSpotProps,
} from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { SatinFloor, type SatinFloorProps } from "../../../src/toolkit/stage/SatinFloor";
import { CYCLES_BARS } from "./cyclesBars";
import { SceneDevices, ShadowCasters, Title } from "./stage";

export const FLOOR_Y = -1.905;
export const LENS: [number, number, number] = [0, -0.985, 11.488];

/** The Cycles reference's key: a 100° spot behind and above the phone, about 15° off the lens, through bars aimed at the lens. Its colour and strength are pulled back from Cycles' because Neutral keeps more saturation than AgX. */
export const KEY: VolumetricSpotProps = {
  position: [-7, 4.85, -7.6],
  target: [1, -1.2, -1],
  angleDeg: 100,
  penumbra: 0.35,
  color: "#ffb877",
  intensity: 520,
  decay: 2,
  grate: {
    lens: LENS,
    offset: 0.3,
    along: [0.15, 7],
    width: 10,
    slat: [0.01, 0.1],
    gap: [0.01, 0.06],
    seed: 42,
    bars: CYCLES_BARS,
    soft: 0.012,
  },
  box: { min: [-10, FLOOR_Y, -30], max: [10, 7, 3] },
  haze: {
    density: 0.08,
    anisotropy: 0.65,
    heightFalloff: 0,
    strength: 1,
    hotspot: 0,
    groundFade: 1.5,
  },
  smoke: {
    scale: 0.4,
    warp: 1.6,
    contrast: [0.47, 0.53],
    floor: 0,
    frontFade: { z0: -2, z1: 2, min: 0.35 },
  },
  extinction: true,
  dust: {},
  floorY: FLOOR_Y,
  castShadow: true,
  shadowMapSize: 2048,
};

/** The Cycles floor: satin, reflecting the phone, fading into the void, glittering where the warm light pools, with the rail's caustic as a floor-only pool. */
export const FLOOR: SatinFloorProps = {
  y: FLOOR_Y,
  color: "#3a2c22",
  roughness: 0.32,
  specular: 0.6,
  centre: [-2, 0.3],
  fade: [3, 11],
  reflection: { strength: 0.7, blur: 30, heightBlur: 0.6, contact: 0.55 },
  glitter: {
    scale: 30,
    density: 0.2,
    roughness: 0.15,
    tilt: 0.5,
    weight: 0.8,
    grain: 0.6,
    seed: 5,
  },
  pools: [
    { at: [-2.6, 0.9], radius: [0.9, 0.35], angleDeg: -20, color: "#ffb070", intensity: 0.15 },
  ],
};

export function MatchStage({
  keyLight,
  floor,
}: {
  keyLight?: Partial<VolumetricSpotProps>;
  floor?: Partial<SatinFloorProps>;
}) {
  return (
    <>
      <Title textKey="title" position={[1.544, 0.03, 0]} fontSize={0.582} tiltDeg={4.9} />
      <ShadowCasters floorY={FLOOR_Y}>
        <SceneDevices />
      </ShadowCasters>
      <SatinFloor {...FLOOR} {...floor} />
      <VolumetricSpot {...KEY} {...keyLight} />
      <VolumetricSpot
        position={[-4.5, 0.5, -1]}
        target={[-3, -1.9, 0.2]}
        angleDeg={50}
        penumbra={1}
        color="#ff9a48"
        intensity={250}
        decay={2}
        gobo={null}
        beam={false}
        floorY={FLOOR_Y}
      />
    </>
  );
}
