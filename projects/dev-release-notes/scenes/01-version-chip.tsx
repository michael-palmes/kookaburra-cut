import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "dev-release-notes-01-version-chip",
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
