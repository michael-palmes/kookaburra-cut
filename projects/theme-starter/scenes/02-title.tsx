import { defineScene, SceneStage, TitleBlock, useSceneText } from "@kookaburra/toolkit";

/**
 * Theme starter scene 2, the large title. Text animates with the THEME's preset defaults
 * (`textAnimation`), so this one composition shows each theme's motion signature. Text
 * lives in the sidecar `scenes/02-title.json`; sizing and alignment come from TitleBlock
 * (theme scale + the sidecar's `textLayout`).
 */
export default defineScene({
  id: "starter-title",
  durationMs: 2600,
  Scene() {
    const title = useSceneText("title", "Make it move");
    const subtitle = useSceneText("subtitle", "Ten themes, one timeline");
    return (
      <SceneStage>
        <TitleBlock title={title} subtitle={subtitle} from={200} to={900} />
      </SceneStage>
    );
  },
});
