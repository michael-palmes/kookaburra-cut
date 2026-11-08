import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameShot } from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-01-name-today",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <NameShot />
      </SceneStage>
    );
  },
});
