import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, SceneDevices, ShadowCasters } from "../lib/staging";

export default defineScene({
  id: "atmos-32-lineup-refined",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <ShadowCasters floorY={-1.5}>
          <SceneDevices />
        </ShadowCasters>
        <LitFloor y={-1.5} color="#3d3129" roughness={0.85} fade={[9, 20]} />
        <VolumetricSpot
          position={[-9, 4.5, -8]}
          target={[2, -1.5, 2]}
          angleDeg={70}
          penumbra={0.6}
          color="#ffb070"
          intensity={350}
          decay={1.6}
          gobo={{
            pattern: "slats",
            count: 4,
            duty: 0.48,
            softness: 0.35,
            angleDeg: 0,
            seed: 3,
            fill: 0.04,
            gain: 0.25,
            ragged: 0.2,
          }}
          haze={{
            density: 0.1,
            anisotropy: 0.55,
            noise: 0.5,
            noiseScale: 0.5,
            heightFalloff: 0.3,
            strength: 1.2,
            hotspot: 0.3,
          }}
          floorY={-1.5}
          castShadow
          shadowMapSize={2048}
          shadowRadius={4}
        />
      </SceneStage>
    );
  },
});
