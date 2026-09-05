import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Preset: the opening title, a headline over one supporting line. */
export default defineScene({
  id: "preset-title-opener",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Ship faster");
    const subtitle = useSceneText("subtitle", "Make it yours");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={80} to={460} subtitleDelayMs={160} />
      </SceneStage>
    );
  },
});
