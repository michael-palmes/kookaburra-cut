import { defineScene, SceneStage, VideoWindow } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Video window". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the scaffolded video-window
 * composition, the window block living in the sidecar.
 */
export default defineScene({
  id: "lab-kind-videowindow",
  durationMs: 3650,
  Scene() {
    return (
      <SceneStage>
        <VideoWindow />
      </SceneStage>
    );
  },
});
