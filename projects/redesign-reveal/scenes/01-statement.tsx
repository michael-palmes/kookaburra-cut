import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "redesign-reveal-01-statement",
  durationMs: 2400,
  Scene() {
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "Make it yours");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={120} to={620} subtitleDelayMs={200} />
      </SceneStage>
    );
  },
});
