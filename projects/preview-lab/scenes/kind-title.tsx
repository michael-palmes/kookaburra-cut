import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Title". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded title composition.
 */
export default defineScene({
  id: "lab-kind-title",
  durationMs: 3000,
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
