import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Auto switching: the panel claims the copy, the capsule cutout keeps the world in frame. */
export default defineScene({
  id: "dark-mode-launch-05-auto-switch",
  durationMs: 2800,
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
