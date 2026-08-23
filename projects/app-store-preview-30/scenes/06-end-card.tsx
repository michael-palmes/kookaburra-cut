import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "app-store-preview-30-06-end-card",
  durationMs: 3600,
  Scene() {
    const title = useSceneText("title", "Kooka");
    const subtitle = useSceneText("subtitle", "Download free");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
