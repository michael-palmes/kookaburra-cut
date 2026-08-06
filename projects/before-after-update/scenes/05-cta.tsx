import { BrandLockup, defineScene, SceneStage, useFormat, useSceneText } from "@kookaburra/toolkit";

/** Before / After Update 5: the end card, icon plus the ask; the ask takes the lockup's hero slot. */
export default defineScene({
  id: "before-after-update-05-cta",
  durationMs: 2400,
  Scene() {
    const format = useFormat();
    const label = useSceneText("title", "App Store");
    const ask = useSceneText("subtitle", "Update");
    // BrandLockup centres off a character-count estimate tuned for sans advances; the theme's mono face runs wider, so the block leans right.
    const lean = format.aspect >= 1.4 ? -0.31 : format.aspect >= 0.9 ? -0.22 : -0.15;
    return (
      <SceneStage>
        <BrandLockup
          title={label}
          subtitle={ask}
          position={[lean, 0, 0]}
          iconWidth={format.aspect < 1 ? 0.5 : 0.9}
        />
      </SceneStage>
    );
  },
});
