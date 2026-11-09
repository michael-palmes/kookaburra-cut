import { defineScene, SceneStage } from "@kookaburra/toolkit";
import { SceneDevices } from "../lib/stage";

export default defineScene({
  id: "unveil-look-lab-03-camera-ring",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <SceneDevices />
      </SceneStage>
    );
  },
});
