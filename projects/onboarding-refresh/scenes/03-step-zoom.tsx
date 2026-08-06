import {
  AnimatedHeadline,
  defineScene,
  LayeredScreenshot,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Onboarding Refresh 3: the same stack settling front-on onto step two, captioned under the frame. */
export default defineScene({
  id: "onboarding-refresh-03-step-zoom",
  durationMs: 3600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const caption = useSceneText("caption", "Step 2");
    return (
      <SceneStage>
        <LayeredScreenshot />
        {caption ? (
          <AnimatedHeadline
            text={caption}
            textKey="caption"
            face="body"
            from={300}
            to={1000}
            position={[0, -1.6, 0]}
            fontSize={portrait ? 0.15 : 0.19}
          />
        ) : null}
      </SceneStage>
    );
  },
});
