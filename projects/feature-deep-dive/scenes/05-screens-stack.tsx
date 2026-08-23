import { defineScene, LayeredScreenshot, SceneStage } from "@kookaburra/toolkit";

/** Feature Deep Dive 5: the screen stack expands to isometric; the sidecar carries it. */
export default defineScene({
  id: "feature-deep-dive-05-screens-stack",
  durationMs: 3800,
  Scene() {
    return (
      <SceneStage>
        <LayeredScreenshot />
      </SceneStage>
    );
  },
});
