import { BrandLockup, defineScene, SceneStage, useFormat, useSceneText } from "@kookaburra/toolkit";

/** Feature Deep Dive 7: the end card, app mark beside the call to action. */
export default defineScene({
  id: "feature-deep-dive-07-cta",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const title = useSceneText("title", "Your App");
    const subtitle = useSceneText("subtitle", "3.1.5");
    // BrandLockup centres off a character-count estimate that runs narrow, so the block leans right.
    const lean = format.aspect >= 1.4 ? -0.18 : format.aspect >= 0.9 ? -0.11 : -0.07;
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} position={[lean, 0, 0]} />
      </SceneStage>
    );
  },
});
