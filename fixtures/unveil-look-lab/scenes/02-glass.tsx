import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { SceneDevices } from "../lib/stage";

export default defineScene({
  id: "unveil-look-lab-02-glass",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
      </SceneStage>
    );
  },
});
