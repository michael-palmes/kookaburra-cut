import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Scene 3: the eligibility panel. The sidecar frame claims the text and the cutout shows the stage. */
export default defineScene({
  id: "subscriber-feature-drop-03-who-gets-it",
  durationMs: 3600,
  Scene() {
    const title = useSceneText("title", "Who gets it");
    const subtitle = useSceneText("subtitle", "");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
