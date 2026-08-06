import { defineScene, SceneStage, TitleBlock, useFormat, useSceneText } from "@kookaburra/toolkit";

/** Scene 1: the tease. Strings, the badge icon, the motion and the background live in the sidecar. */
export default defineScene({
  id: "subscriber-feature-drop-01-tease",
  durationMs: 2000,
  Scene() {
    const format = useFormat();
    const title = useSceneText("title", "Something for Pro");
    const subtitle = useSceneText("subtitle", "");
    return (
      <SceneStage>
        <TitleBlock
          title={title}
          subtitle={subtitle}
          from={150}
          to={800}
          maxWidth={format.frame.width - format.safe.left - format.safe.right}
        />
      </SceneStage>
    );
  },
});
