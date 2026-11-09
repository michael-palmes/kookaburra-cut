import { defineScene, ImageCard, SceneStage } from "@kookaburra/toolkit";
import { VolumetricSpot } from "../../../src/toolkit/lighting/atmosphere/VolumetricSpot";
import { Title } from "../lib/stage";

export default defineScene({
  id: "unveil-look-lab-18-lockup",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <ImageCard src="assets/fairywren-icon.png" width={1.5} position={[0, 0.62, 0]} />
        <Title textKey="title" position={[0, -0.72, 0]} fontSize={0.62} />
        <Title textKey="line" position={[0, -1.22, 0]} fontSize={0.2} face="body" colour="muted" />
        <VolumetricSpot
          position={[0, 0.6, -6]}
          target={[0, 0.6, 0]}
          angleDeg={110}
          penumbra={1}
          color="#ff8a3a"
          intensity={2.2}
          decay={1}
          gobo={{
            pattern: "dapple",
            count: 5,
            duty: 0.6,
            softness: 0.7,
            angleDeg: 20,
            seed: 11,
            fill: 0.35,
          }}
          haze={{
            density: 0.5,
            anisotropy: 0.4,
            noise: 1,
            noiseScale: 1.2,
            heightFalloff: 0,
            strength: 1,
            hotspot: 0.3,
          }}
          distance={7}
          floorY={-8}
        />
      </SceneStage>
    );
  },
});
