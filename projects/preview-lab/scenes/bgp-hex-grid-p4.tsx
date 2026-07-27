import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "hex-grid" fill ("Kata Tjuta"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's shader background IS the content.
 */
export default defineScene({
  id: "lab-bgp-hex-grid-p4",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
