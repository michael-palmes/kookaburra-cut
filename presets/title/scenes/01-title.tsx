import { defineScene, SceneStage, TitleBlock, useFormat, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "title",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const textWidth = format.frame.width - format.safe.left - format.safe.right;
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "Make it yours");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} maxWidth={textWidth} />
      </SceneStage>
    );
  },
});
