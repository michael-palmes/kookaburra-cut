import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDuration,
  useSceneText,
} from "@kookaburra/toolkit";

const OUT_MS = 165;

export default defineScene({
  id: "unveil-08-claim-2",
  durationMs: 1875,
  Scene() {
    const { frame, safe } = useFormat();
    const endMs = useSceneDuration();
    const claim = useSceneText("title", "Moves your plans\nautomatically.");

    return (
      <SceneStage floorY={-1.905}>
        <AnimatedHeadline
          text={claim}
          textKey="title"
          hitAt={0}
          outAt={endMs - OUT_MS}
          outDurationMs={OUT_MS}
          fontSize={0.46}
          textAlign="center"
          fit="width"
          maxWidth={(frame.width - safe.left - safe.right) * 0.76}
        />
      </SceneStage>
    );
  },
});
