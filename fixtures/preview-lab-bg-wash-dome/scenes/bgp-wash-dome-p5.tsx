import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "wash-dome" 3D background ("Jervis Bay"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-wash-dome-p5",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
