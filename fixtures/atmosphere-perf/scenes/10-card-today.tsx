import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { SceneDevices } from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-10-card-today",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
      </SceneStage>
    );
  },
});
