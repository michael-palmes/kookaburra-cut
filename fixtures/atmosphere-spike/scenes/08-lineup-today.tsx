import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { SceneDevices } from "../lib/staging";

export default defineScene({
  id: "atmos-08-lineup-today",
  durationMs: 2000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
      </SceneStage>
    );
  },
});
