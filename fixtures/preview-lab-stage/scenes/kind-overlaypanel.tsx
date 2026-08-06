import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Overlay panel". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded panel-only
 * composition: the cutout collapses to a sliver so the panel reads full-frame.
 */
export default defineScene({
  id: "lab-kind-overlaypanel",
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
