import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { CardDevice } from "../../atmosphere-spike/lib/card";

export default defineScene({
  id: "atmos-perf-41-card-today",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <CardDevice />
      </SceneStage>
    );
  },
});
