import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "App version". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded lockup composition.
 */
export default defineScene({
  id: "lab-kind-appversion",
  durationMs: 3000,
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
