import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { SceneDevices } from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-11-card-volumetric",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
        <VolumetricSpot
          position={[6.5, 4.5, -10]}
          target={[0.4, 0.8, 2.6]}
          angleDeg={34}
          penumbra={0.9}
          color="#ff9a4a"
          intensity={45}
          decay={1}
          gobo={{ pattern: "dapple", count: 4, duty: 0.55, softness: 0.6, angleDeg: 20, seed: 11 }}
          haze={{
            density: 0.16,
            anisotropy: 0.7,
            noise: 1,
            noiseScale: 0.7,
            heightFalloff: 0,
            strength: 1,
          }}
          floorY={-6}
        />
      </SceneStage>
    );
  },
});
