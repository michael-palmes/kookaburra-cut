import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — light-mode animated-background sample for the "warp" fill (the "Sandstone"
 * p1 preset). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews` into the
 * committed picker preview clips (src/assets/option-previews/), shown by the Animated tab when
 * the project theme is light. UNSTAGED and empty on purpose: the sidecar's shader background IS
 * the content, exactly as applying the p1 preset writes it.
 */
export default defineScene({
  id: "lab-bg-warp-light",
  durationMs: 2000,
  Scene() {
    return null;
  },
});
