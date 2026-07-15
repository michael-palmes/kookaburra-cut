import { defineScene, SceneStage, TitleBlock, useFormat, useSceneText } from "@kookaburra/toolkit";

/**
 * Showcase tour scene 3 — Neon: the char-staggered blur-in in the mono face on OLED black,
 * with the theme's bloom picking up the accent subtitle.
 */
export default defineScene({
  id: "tour-neon-type",
  durationMs: 2600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title", "TYPE // ONLINE");
    const subtitle = useSceneText("subtitle", "char-staggered blur-in");
    return (
      <SceneStage>
        <TitleBlock
          title={title}
          subtitle={subtitle}
          from={200}
          to={800}
          fontSize={portrait ? 0.24 : 0.4}
          subtitleColor="accent"
          subtitleDelayMs={700}
        />
      </SceneStage>
    );
  },
});
