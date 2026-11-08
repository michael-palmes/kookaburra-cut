import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { NameShot } from "../lib/staging";

export default defineScene({
  id: "atmos-02-name-shafts-full",
  durationMs: 2000,
  Scene() {
    return (
      <SceneStage>
        <NameShot />
      </SceneStage>
    );
  },
});
