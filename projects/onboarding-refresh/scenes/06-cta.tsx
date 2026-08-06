import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/** Onboarding Refresh 6: the end card, app mark plus the call to action. */
export default defineScene({
  id: "onboarding-refresh-06-cta",
  durationMs: 3000,
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
