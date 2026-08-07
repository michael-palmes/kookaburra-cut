import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Image". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the sidecar's background image fills
 * the frame cover-cropped, so the composition stays empty and unstaged (mirrors the
 * image template).
 */
export default defineScene({
  id: "lab-kind-image",
  durationMs: 3650,
  Scene() {
    return null;
  },
});
