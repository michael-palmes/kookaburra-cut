import { defineScene, LayeredScreenshot, SceneStage } from "@kookaburra/toolkit";

/** Onboarding Refresh 2: the three first-run screens as one stack; the sidecar carries it. */
export default defineScene({
  id: "onboarding-refresh-02-step-stack",
  durationMs: 4000,
  Scene() {
    return (
      <SceneStage>
        <LayeredScreenshot />
      </SceneStage>
    );
  },
});
