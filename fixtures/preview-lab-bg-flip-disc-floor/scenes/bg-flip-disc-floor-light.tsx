import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — light-mode 3D background sample for "flip-disc-floor" ("Wallaman"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bg-flip-disc-floor-light",
  durationMs: 2000,
  Scene() {
    return null;
  },
});
