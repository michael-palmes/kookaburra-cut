import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Title + icon". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded title composition
 * with the sidecar's headerIcon drawn above the headline.
 */
export default defineScene({
  id: "lab-kind-titleicon",
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
