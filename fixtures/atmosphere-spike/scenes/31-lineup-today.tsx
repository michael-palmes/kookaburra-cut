import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { SceneDevices } from "../lib/staging";

export default defineScene({
  id: "atmos-31-lineup-today",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
      </SceneStage>
    );
  },
});
