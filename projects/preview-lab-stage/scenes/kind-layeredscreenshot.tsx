import { defineScene, LayeredScreenshot, SceneStage } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Layered screenshot". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the sidecar carries the stack.
 */
export default defineScene({
  id: "lab-kind-layeredscreenshot",
  durationMs: 3000,
  Scene() {
    return (
      <SceneStage>
        <LayeredScreenshot />
      </SceneStage>
    );
  },
});
