import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/**
 * Theme starter scene 3, the app-version slide as a horizontal brand lockup: icon left,
 * app name over a hero version line to its right, revealed as one unit with a shine sweep.
 * Swap `assets/app-icon.png` for the real icon; strings live in the sidecar.
 */
export default defineScene({
  id: "starter-app-version",
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
