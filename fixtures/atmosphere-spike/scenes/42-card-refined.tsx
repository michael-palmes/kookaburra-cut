import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { CardDevice } from "../lib/card";

export default defineScene({
  id: "atmos-42-card-refined",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <CardDevice />
        <VolumetricSpot
          position={[3.1, 1.8, -4.4]}
          target={[-2.3, -0.7, 0.5]}
          angleDeg={120}
          penumbra={1}
          color="#ff8a3a"
          intensity={1.6}
          decay={1}
          gobo={{
            pattern: "dapple",
            count: 5,
            duty: 0.6,
            softness: 0.7,
            angleDeg: 20,
            seed: 11,
            fill: 0.3,
          }}
          haze={{
            density: 0.55,
            anisotropy: 0.3,
            noise: 1,
            noiseScale: 1.5,
            heightFalloff: 0,
            strength: 1,
            hotspot: 0,
          }}
          floorY={-8}
        />
      </SceneStage>
    );
  },
});
