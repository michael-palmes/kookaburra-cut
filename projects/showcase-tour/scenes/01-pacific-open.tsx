import { defineScene, SceneStage, TitleBlock, useFormat, useSceneText } from "@kookaburra/toolkit";

/**
 * Showcase tour scene 1 — Pacific: the word-staggered fade-up (the theme's default motion)
 * over the blue→white gradient backdrop. Theme comes from the sidecar's `themeId`.
 */
export default defineScene({
  id: "tour-pacific-open",
  durationMs: 2800,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title", "Every theme, one reel");
    const subtitle = useSceneText("subtitle", "Staged, lit and typeset per scene");
    return (
      <SceneStage>
        <TitleBlock
          title={title}
          subtitle={subtitle}
          from={200}
          to={900}
          fontSize={portrait ? 0.3 : 0.5}
          subtitleDelayMs={500}
        />
      </SceneStage>
    );
  },
});
