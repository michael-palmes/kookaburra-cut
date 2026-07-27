import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "mesh-gradient" fill ("Bass Strait"). DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview stills
 * (src/assets/option-previews/). UNSTAGED and empty on purpose: the sidecar's shader
 * background IS the content, exactly as the app's preset tiles write it.
 */
export default defineScene({
  id: "lab-bgp-mesh-gradient-p6",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
