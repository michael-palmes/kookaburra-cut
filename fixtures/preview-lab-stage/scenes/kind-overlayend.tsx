import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Cutout end". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded overlay
 * composition: the panel claims the text, the cutout shows the staged scene.
 */
export default defineScene({
  id: "lab-kind-overlayend",
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
