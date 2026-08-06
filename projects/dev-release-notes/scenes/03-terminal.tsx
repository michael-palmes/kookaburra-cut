import { defineScene, SceneStage, VideoWindow } from "@kookaburra/toolkit";

export default defineScene({
  id: "dev-release-notes-03-terminal",
  durationMs: 5000,
  Scene() {
    return (
      <SceneStage>
        <VideoWindow />
      </SceneStage>
    );
  },
});
