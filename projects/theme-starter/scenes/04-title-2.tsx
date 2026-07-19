import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Theme starter scene 4, the second title beat between the two device scenes. Same
 * TitleBlock composition as scene 2 so the theme's motion signature repeats; text lives
 * in the sidecar `scenes/04-title-2.json`.
 */
export default defineScene({
  id: "starter-title-2",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Every angle");
    const subtitle = useSceneText("subtitle", "Per-scene camera moves");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={200} to={900} />
      </SceneStage>
    );
  },
});
