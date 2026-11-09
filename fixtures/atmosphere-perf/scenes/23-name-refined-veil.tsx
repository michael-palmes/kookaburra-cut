import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import {
  LitFloor,
  NameTitle,
  SceneDevices,
  ShadowCasters,
} from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-23-name-refined-veil",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <NameTitle position={[1.544, 0.03, 0]} fontSize={0.582} tiltDeg={4.9} />
        <ShadowCasters floorY={-1.905}>
          <SceneDevices />
        </ShadowCasters>
        <LitFloor y={-1.905} color="#140d09" roughness={0.72} centre={[-2, 0.3]} fade={[1, 7]} />
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
            count: 22,
            duty: 0.5,
            softness: 0.32,
            angleDeg: 90,
            seed: 7,
            gain: 0.6,
            ragged: 0.5,
          }}
          haze={{
            density: 0.3,
            anisotropy: 0.65,
            noise: 0.5,
            noiseScale: 1.1,
            heightFalloff: 0.12,
            strength: 2,
            hotspot: 0.6,
          }}
          distance={10}
          floorY={-1.905}
          castShadow
          veil
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
          beam
          floorY={-1.905}
          veil
          haze={{
            density: 0.6,
            anisotropy: 0.4,
            noise: 0.6,
            noiseScale: 1.2,
            heightFalloff: 1.6,
            strength: 1.2,
            hotspot: 0,
          }}
        />
        <VolumetricSpot
          position={[-6, 0.6, 3.5]}
          target={[-2, 0, -0.3]}
          angleDeg={34}
          penumbra={1}
          color="#ffb066"
          intensity={70}
          decay={2}
          gobo={null}
          beam={false}
          floorY={-1.905}
        />
      </SceneStage>
    );
  },
});
