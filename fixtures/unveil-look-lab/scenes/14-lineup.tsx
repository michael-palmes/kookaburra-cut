import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, SceneDevices, ShadowCasters } from "../lib/stage";

const FLOOR_Y = -1.5;

export default defineScene({
  id: "unveil-look-lab-14-lineup",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <ShadowCasters floorY={FLOOR_Y}>
          <SceneDevices />
        </ShadowCasters>
        <LitFloor y={FLOOR_Y} color="#3d3129" fade={[9, 20]} />
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
          floorY={FLOOR_Y}
          castShadow
          shadowMapSize={2048}
          shadowRadius={4}
        />
      </SceneStage>
    );
  },
});
