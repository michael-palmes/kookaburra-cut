import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "dust-drift" 3D background ("Coalsack"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-dust-drift-p6",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
