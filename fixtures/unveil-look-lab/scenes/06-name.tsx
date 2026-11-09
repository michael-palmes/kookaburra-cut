import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, SceneDevices, ShadowCasters, Title } from "../lib/stage";

const FLOOR_Y = -1.905;

export default defineScene({
  id: "unveil-look-lab-06-name",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <Title textKey="title" position={[1.544, 0.03, 0]} fontSize={0.582} tiltDeg={4.9} />
        <ShadowCasters floorY={FLOOR_Y}>
          <SceneDevices />
        </ShadowCasters>
        <LitFloor y={FLOOR_Y} color="#140d09" centre={[-2, 0.3]} fade={[1, 7]} />
        <VolumetricSpot
          position={[-4.808, 3.166, -1.547]}
          target={[0.859, -1.224, -2.484]}
          angleDeg={72}
          penumbra={0.7}
          color="#ffa552"
          intensity={260}
          decay={2}
          gobo={{
            pattern: "slats",
            count: 30,
            duty: 0.3,
            softness: 0.5,
            angleDeg: 90,
            seed: 7,
            gain: 0.9,
            ragged: 0.6,
            fill: 0.05,
          }}
          haze={{
            density: 0.3,
            anisotropy: 0.65,
            noise: 0.8,
            noiseScale: 1.1,
            heightFalloff: 0.12,
            strength: 2,
            hotspot: 0.6,
          }}
          distance={10}
          floorY={FLOOR_Y}
          castShadow
        />
        <VolumetricSpot
          position={[-3.6, -0.6, 1.4]}
          target={[-2.5, -1.97, 0.3]}
          angleDeg={60}
          penumbra={1}
          color="#ff9a48"
          intensity={26}
          decay={2}
          gobo={null}
          beam={false}
          floorY={FLOOR_Y}
        />
      </SceneStage>
    );
  },
});
