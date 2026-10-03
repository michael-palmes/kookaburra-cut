import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — 3D background sample for "rain-canopy" ("Blackwood"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bg-rain-canopy",
  durationMs: 2000,
  Scene() {
    return null;
  },
});
