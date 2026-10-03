import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "aurora-veil" 3D background ("Nightcliff"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-aurora-veil-p7",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
