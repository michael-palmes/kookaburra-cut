import {
  AnimatedHeadline,
  Chart,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/** Scene 3: the frame-rate line. Data, axis and build-in all come from the sidecar. */
export default defineScene({
  id: "performance-release-stats-03-frame-rate",
  durationMs: 3800,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
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
        <Chart />
      </SceneStage>
    );
  },
});
