import { BrandLockup, defineScene, SceneStage, useFormat, useSceneText } from "@kookaburra/toolkit";

/** Scene 6: the upgrade card. Swap `assets/app-icon.png` for the real icon; strings live in the sidecar. */
export default defineScene({
  id: "subscriber-feature-drop-06-upgrade-cta",
  durationMs: 3200,
  Scene() {
    const format = useFormat();
    const title = useSceneText("title", "Upgrade in the app");
    const subtitle = useSceneText("subtitle", "Kooka Pro");
    // BrandLockup centres off a character-count estimate that runs narrow, so the block leans right.
    const lean =
      format.aspect >= 1.4
        ? -0.44
        : format.aspect >= 0.9
          ? -0.28
          : format.aspect >= 0.7
            ? -0.21
            : -0.16;
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} position={[lean, 0, 0]} />
      </SceneStage>
    );
  },
});
