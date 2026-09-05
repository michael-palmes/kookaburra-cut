import {
  AnimatedHeadline,
  Chart,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "chart",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const textWidth = format.frame.width - format.safe.left - format.safe.right;
    const safeTop = format.frame.height / 2 - format.safe.top;
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
            position={[0, portrait ? safeTop : 1.72, 0]}
            anchorY={portrait ? "top" : undefined}
            fontSize={portrait ? 0.23 : 0.42}
            maxWidth={textWidth}
            textAlign="center"
          />
        ) : null}
        <Chart />
      </SceneStage>
    );
  },
});
