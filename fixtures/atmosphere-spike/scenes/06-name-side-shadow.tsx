import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { LitFloor, NAME_FLOOR_Y, NameShot } from "../lib/staging";

export default defineScene({
  id: "atmos-06-name-side-shadow",
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
        />
        <VolumetricSpot
          position={[-7.5, 1.6, -0.6]}
          target={[3, -0.2, 0.2]}
          angleDeg={26}
          penumbra={0.35}
          color="#ffab5a"
          intensity={60}
          decay={1.2}
          gobo={{ pattern: "slats", count: 9, duty: 0.45, softness: 0.35, angleDeg: 90, seed: 5 }}
          haze={{
            density: 0.3,
            anisotropy: 0.6,
            noise: 0.5,
            noiseScale: 0.9,
            heightFalloff: 0.12,
            strength: 1,
          }}
          floorY={NAME_FLOOR_Y}
          castShadow
        />
      </SceneStage>
    );
  },
});
