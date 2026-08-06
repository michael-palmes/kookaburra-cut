import { BrandLockup, defineScene, SceneStage, useFormat, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "dev-release-notes-07-docs-cta",
  durationMs: 3600,
  Scene() {
    const format = useFormat();
    const title = useSceneText("title", "Your App");
    const subtitle = useSceneText("subtitle", "3.1.5");
    // BrandLockup centres off a character-count estimate tuned for sans advances; the URL runs in the mono face, so the block leans right.
    const lean = format.aspect >= 1.4 ? -0.31 : format.aspect >= 0.9 ? -0.22 : -0.15;
    return (
      <SceneStage>
        <BrandLockup
          title={title}
          subtitle={subtitle}
          position={[lean, 0, 0]}
          iconWidth={format.aspect < 1 ? 0.5 : 0.9}
          icon="assets/kooka-icon-dark-sample.png"
        />
      </SceneStage>
    );
  },
});
