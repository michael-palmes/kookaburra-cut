import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "drift-slabs" 3D background ("Ormiston"). DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview assets (src/assets/option-previews/). UNSTAGED and empty on
 * purpose: the sidecar's 3D background IS the content.
 */
export default defineScene({
  id: "lab-bgp-drift-slabs-p7",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
