import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { CardDevice } from "../lib/card";

export default defineScene({
  id: "atmos-41-card-today",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <CardDevice />
      </SceneStage>
    );
  },
});
