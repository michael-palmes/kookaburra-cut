import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/** Onboarding Refresh 1: the claim. Text, motion and background all live in the sidecar. */
export default defineScene({
  id: "onboarding-refresh-01-fewer-steps",
  durationMs: 2400,
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
