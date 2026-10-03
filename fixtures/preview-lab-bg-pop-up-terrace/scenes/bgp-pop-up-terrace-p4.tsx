import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "pop-up-terrace" 3D background ("Trevallyn"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-pop-up-terrace-p4",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
