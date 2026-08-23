import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
  VideoWindow,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "changelog-rundown-03-added-demo",
  durationMs: 3200,
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
            position={[0, portrait ? 1.8 : 1.6, 0]}
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
            position={[0, portrait ? 1.58 : 1.22, 0]}
            fontSize={(portrait ? 0.23 : 0.42) / theme.typography.scale ** 4}
          />
        ) : null}
        <VideoWindow />
      </SceneStage>
    );
  },
});
