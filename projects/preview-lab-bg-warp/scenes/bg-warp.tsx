import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — animated-background sample for the "warp" fill. DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview clips
 * (src/assets/option-previews/). UNSTAGED and empty on purpose: the sidecar's shader
 * background IS the content, exactly as the app's Animated tab writes it.
 */
export default defineScene({
  id: "lab-bg-warp",
  durationMs: 2000,
  Scene() {
    return null;
  },
});
