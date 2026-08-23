import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "changelog-rundown-07-read-full",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Your App");
    const subtitle = useSceneText("subtitle", "3.1.5");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
