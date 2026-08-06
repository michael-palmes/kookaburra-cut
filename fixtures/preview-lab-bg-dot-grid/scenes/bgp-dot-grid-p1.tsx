import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "dot-grid" fill ("Cottesloe"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's shader background IS the content.
 */
export default defineScene({
  id: "lab-bgp-dot-grid-p1",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
