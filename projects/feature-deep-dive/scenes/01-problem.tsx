import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Feature Deep Dive 1: names the problem, with the muted body line under it. */
export default defineScene({
  id: "feature-deep-dive-01-problem",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "Make it yours");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
