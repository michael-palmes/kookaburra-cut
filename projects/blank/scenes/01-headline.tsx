import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/**
 * The "Blank" template's single starting scene (v6): one headline to replace.
 * Authoring rules (see .claude/skills/kookaburra-scene-authoring): default-export a
 * `defineScene`, animate only off the timeline, text via toolkit primitives,
 * colours via theme tokens, laid-out content at z=0. User-visible text lives in the
 * sidecar `scenes/01-headline.json` text map. `<SceneStage>` mounts the theme's
 * staging (lights, backdrop, shadows) and honours the sidecar's stage overrides.
 */
export default defineScene({
  id: "headline",
  durationMs: 4000,
  Scene() {
    const theme = useTheme();
    const headline = useSceneText("headline", "Your video starts here");

    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          from={0}
          to={theme.motion.durations.base}
          position={[0, 0, 0]}
        />
      </SceneStage>
    );
  },
});
