import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameShot } from "../../atmosphere-spike/lib/staging";

export default defineScene({
  id: "atmos-perf-02-name-shafts-full",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <NameShot />
      </SceneStage>
    );
  },
});
