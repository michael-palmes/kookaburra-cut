import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Feature Deep Dive 2: the hero reveal, the feature's name on its own. */
export default defineScene({
  id: "feature-deep-dive-02-feature-name",
  durationMs: 2000,
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
