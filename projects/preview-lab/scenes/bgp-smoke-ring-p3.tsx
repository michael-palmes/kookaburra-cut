import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab — preset still for the "smoke-ring" fill ("Rock Pool"). DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview stills
 * (src/assets/option-previews/). UNSTAGED and empty on purpose: the sidecar's shader
 * background IS the content, exactly as the app's preset tiles write it.
 */
export default defineScene({
  id: "lab-bgp-smoke-ring-p3",
  durationMs: 1000,
  Scene() {
    return null;
  },
});
