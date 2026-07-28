import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — light-mode sample for the "horizon-grid" fill (the "Cable Beach" p1 preset). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's shader background IS the content.
 */
export default defineScene({
  id: "lab-bg-horizon-grid-light",
  durationMs: 2000,
  Scene() {
    return null;
  },
});
