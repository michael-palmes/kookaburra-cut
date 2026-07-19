import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/**
 * Theme starter scene 6, the closing app-version slide: the same brand lockup as the
 * opener bookending the video. Strings live in the sidecar `scenes/06-app-version-end.json`.
 */
export default defineScene({
  id: "starter-app-version-end",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Your App");
    const subtitle = useSceneText("subtitle", "3.1.5");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
