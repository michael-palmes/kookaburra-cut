import { defineScene, LayeredScreenshot, SceneStage } from "@kookaburra/toolkit";

/** Scene 4: the settings stack. Screens, the caption and the spread animation live in the sidecar. */
export default defineScene({
  id: "subscriber-feature-drop-04-turn-it-on",
  durationMs: 3600,
  Scene() {
    return (
      <SceneStage>
        <LayeredScreenshot />
      </SceneStage>
    );
  },
});
