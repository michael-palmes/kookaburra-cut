import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "whats-new-social-cut-01-version-hook",
  durationMs: 1800,
  Scene() {
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "Make it yours");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={80} to={520} subtitleDelayMs={220} />
      </SceneStage>
    );
  },
});
