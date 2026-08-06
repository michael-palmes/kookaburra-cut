import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "changelog-rundown-06-known-issues",
  durationMs: 3400,
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
