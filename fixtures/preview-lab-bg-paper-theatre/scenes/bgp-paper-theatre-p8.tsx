import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "paper-theatre" 3D background ("Eddystone Point"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-paper-theatre-p8",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
