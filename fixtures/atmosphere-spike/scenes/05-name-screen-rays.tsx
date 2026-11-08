import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { ScreenRays } from "../../../src/toolkit/lighting/atmosphere/ScreenRays";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, NAME_FLOOR_Y, NameShot } from "../lib/staging";

export default defineScene({
  id: "atmos-05-name-screen-rays",
  durationMs: 2000,
  Scene() {
    return (
      <SceneStage>
        <NameShot castShadows />
        <LitFloor
          y={NAME_FLOOR_Y}
          color="#0d0a08"
          roughness={0.8}
          centre={[-1.6, 0.6]}
          fade={[1.5, 9]}
          noOcclude
        />
        <VolumetricSpot
          position={[-6.2, 4.6, -3.8]}
          target={[1.4, -1.6, 1.2]}
          angleDeg={52}
          penumbra={0.6}
          color="#ffab5a"
          intensity={150}
          decay={2.1}
          gobo={{ pattern: "slats", count: 19, duty: 0.28, softness: 0.3, angleDeg: 90, seed: 7 }}
          haze={{
            density: 0.22,
            anisotropy: 0.6,
            noise: 0.75,
            noiseScale: 0.9,
            heightFalloff: 0.12,
            strength: 1,
          }}
          floorY={NAME_FLOOR_Y}
          beam={false}
          castShadow
        />
        <ScreenRays
          source={[-6.2, 4.6, -3.8]}
          color="#ffab5a"
          intensity={0.45}
          length={0.95}
          decay={0.975}
          spread={0.3}
          stripes={{ count: 9, duty: 0.45, softness: 0.7, seed: 7 }}
        />
      </SceneStage>
    );
  },
});
