import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
  VideoWindow,
} from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Video window". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the exact scaffolded composition,
 * with the window block and managed copy living in the sidecar.
 */
export default defineScene({
  id: "lab-kind-videowindow",
  durationMs: 3650,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    const subtitle = useSceneText("subtitle");
    return (
      <SceneStage>
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={900}
            position={[0, portrait ? 1.9 : 1.72, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        {subtitle ? (
          <AnimatedHeadline
            text={subtitle}
            textKey="subtitle"
            face="body"
            defaultColor="muted"
            from={550}
            to={1250}
            position={[0, portrait ? 1.68 : 1.34, 0]}
            fontSize={(portrait ? 0.23 : 0.42) / theme.typography.scale ** 4}
          />
        ) : null}
        <VideoWindow />
      </SceneStage>
    );
  },
});
