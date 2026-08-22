import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Scene 1: the version header. Strings, the icon and the background live in the sidecar. */
export default defineScene({
  id: "quality-release-notes-01-quiet-header",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "v2.4.1");
    const subtitle = useSceneText("subtitle", "Stability release");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
