import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "dev-release-notes-04-api-diff",
  durationMs: 4800,
  Scene() {
    const format = useFormat();
    const code = useSceneText("code");
    return (
      <SceneStage>
        {code ? (
          <AnimatedHeadline
            text={code}
            textKey="code"
            from={300}
            to={1000}
            fontSize={format.frame.width * 0.055}
            maxWidth={format.frame.width * 0.86}
            textAlign="left"
          />
        ) : null}
      </SceneStage>
    );
  },
});
