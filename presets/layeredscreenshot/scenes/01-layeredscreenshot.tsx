import { defineScene, LayeredScreenshot, SceneStage, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "layeredscreenshot",
  durationMs: 3000,
  Scene() {
    const title = useSceneText("title");
    return (
      <SceneStage>
        <LayeredScreenshot title={title} />
      </SceneStage>
    );
  },
});
