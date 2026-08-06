import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Scene 2: the panel claims the title and bullets, so the in-world TitleBlock stands down. */
export default defineScene({
  id: "quality-release-notes-02-fixed-list",
  durationMs: 4000,
  Scene() {
    const title = useSceneText("title", "You reported these");
    const subtitle = useSceneText("subtitle", "");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
