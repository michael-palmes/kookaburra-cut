import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "whats-new-social-cut-05-recap-panel",
  durationMs: 2400,
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
