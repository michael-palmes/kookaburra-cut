import { defineScene } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Video". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the sidecar's background video fills
 * the frame, so the composition stays empty and unstaged (mirrors the video template).
 */
export default defineScene({
  id: "lab-kind-video",
  durationMs: 3650,
  Scene() {
    return null;
  },
});
