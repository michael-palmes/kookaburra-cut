import { defineScene } from "@kookaburra/toolkit";

// The sidecar's background video fills the frame, so the composition stays empty and unstaged.
export default defineScene({
  id: "app-store-preview-30-01-cold-open",
  durationMs: 4000,
  Scene() {
    return null;
  },
});
