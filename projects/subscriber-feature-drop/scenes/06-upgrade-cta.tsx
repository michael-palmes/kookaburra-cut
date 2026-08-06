import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/** Scene 6: the upgrade card. Swap `assets/app-icon.png` for the real icon; strings live in the sidecar. */
export default defineScene({
  id: "subscriber-feature-drop-06-upgrade-cta",
  durationMs: 3200,
  Scene() {
    const title = useSceneText("title", "Kooka Pro 4.2");
    const subtitle = useSceneText("subtitle", "Upgrade");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
