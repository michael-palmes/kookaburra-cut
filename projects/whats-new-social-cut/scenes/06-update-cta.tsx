import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "whats-new-social-cut-06-update-cta",
  durationMs: 2200,
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
