import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/** The end card: app mark, version in mono, the call to action as the hero line. */
export default defineScene({
  id: "dark-mode-launch-06-cta",
  durationMs: 2800,
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
