import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameShot } from "../lib/staging";

export default defineScene({
  id: "atmos-01-name-today",
  durationMs: 2000,
  Scene() {
    return (
      <SceneStage>
        <NameShot />
      </SceneStage>
    );
  },
});
