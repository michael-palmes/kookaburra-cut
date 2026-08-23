import {
  AnimatedHeadline,
  Chart,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/** Scene 2: cold start by release. Every chart knob lives in the sidecar's chart block. */
export default defineScene({
  id: "performance-release-stats-02-launch-time",
  durationMs: 4000,
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
