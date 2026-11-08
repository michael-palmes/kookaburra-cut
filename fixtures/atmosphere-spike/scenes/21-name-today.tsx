import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameTitle, SceneDevices } from "../lib/staging";

export default defineScene({
  id: "atmos-21-name-today",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <NameTitle position={[1.544, 0.03, 0]} fontSize={0.582} tiltDeg={4.9} />
        <SceneDevices />
      </SceneStage>
    );
  },
});
