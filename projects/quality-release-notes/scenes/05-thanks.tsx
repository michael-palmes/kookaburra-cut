import { BrandLockup, defineScene, SceneStage, useSceneText } from "@kookaburra/toolkit";

/** Scene 5: the end card. BrandLockup renders the subtitle as the hero line, so the message goes there and the version stays the small label. */
export default defineScene({
  id: "quality-release-notes-05-thanks",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "v2.4.1");
    const subtitle = useSceneText("subtitle", "Thank you");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
      </SceneStage>
    );
  },
});
