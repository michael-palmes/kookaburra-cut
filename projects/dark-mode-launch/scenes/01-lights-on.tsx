import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** The light "before": the statement that opens the film, staged on the white theme. */
export default defineScene({
  id: "dark-mode-launch-01-lights-on",
  durationMs: 2200,
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
