import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, SceneDevices, ShadowCasters } from "../lib/staging";

export default defineScene({
  id: "atmos-09-lineup-volumetric",
  durationMs: 2000,
  Scene() {
    return (
      <SceneStage>
        <ShadowCasters floorY={-1.5}>
          <SceneDevices />
        </ShadowCasters>
        <LitFloor y={-1.5} color="#16110d" roughness={0.86} fade={[7, 16]} />
        <VolumetricSpot
          position={[-8.5, 5, -6.5]}
          target={[1.2, -1.5, 1]}
          angleDeg={56}
          penumbra={0.35}
          color="#ffab5a"
          intensity={170}
          decay={1.2}
          gobo={{ pattern: "slats", count: 7, duty: 0.5, softness: 0.26, angleDeg: 0, seed: 3 }}
          haze={{
            density: 0.05,
            anisotropy: 0.55,
            noise: 0.6,
            noiseScale: 0.4,
            heightFalloff: 0.5,
            strength: 1,
          }}
          floorY={-1.5}
          castShadow
          shadowMapSize={2048}
          shadowRadius={2}
        />
      </SceneStage>
    );
  },
});
