import { Chart, defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Scene 5: the method panel claims the text (the TitleBlock stands down), so the scene window holds the bar chart. */
export default defineScene({
  id: "performance-release-stats-05-panel-chart",
  durationMs: 5000,
  Scene() {
    const title = useSceneText("title", "How we measured");
    const subtitle = useSceneText("subtitle", "iOS 26.2, release builds");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} />
        <Chart />
      </SceneStage>
    );
  },
});
