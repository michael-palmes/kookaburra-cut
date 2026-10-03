import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "blue-and-gold" 3D background ("Hawkesbury"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-blue-and-gold-p1",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
