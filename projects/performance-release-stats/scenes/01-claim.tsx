import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Scene 1: the claim. Strings, motion and the background live in the sidecar. */
export default defineScene({
  id: "performance-release-stats-01-claim",
  durationMs: 2400,
  Scene() {
    const title = useSceneText("title", "2.4 is quicker\neverywhere");
    const subtitle = useSceneText("subtitle", "Measured, not claimed");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
