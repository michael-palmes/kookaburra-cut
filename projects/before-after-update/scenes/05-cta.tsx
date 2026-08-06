import { BrandLockup, defineScene, SceneStage, useFormat, useSceneText } from "@kookaburra/toolkit";

/** Before / After Update 5: the end card, icon plus the ask; the ask takes the lockup's hero slot. */
export default defineScene({
  id: "before-after-update-05-cta",
  durationMs: 2400,
  Scene() {
    const format = useFormat();
    const label = useSceneText("title", "App Store");
    const ask = useSceneText("subtitle", "Update");
    return (
      <SceneStage>
        <BrandLockup title={label} subtitle={ask} iconWidth={format.aspect < 1 ? 0.5 : 0.9} />
      </SceneStage>
    );
  },
});
