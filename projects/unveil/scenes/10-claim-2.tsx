import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-10-claim-2",
  durationMs: 1875,
  Scene() {
    const { frame, safe } = useFormat();
    const claim = useSceneText("title", "Moves your plans\nautomatically.");

    return (
      <SceneStage floorY={-1.905}>
        <AnimatedHeadline
          text={claim}
          textKey="title"
          hitAt={0}
          outAt={1710}
          outDurationMs={165}
          fontSize={0.46}
          textAlign="center"
          fit="width"
          maxWidth={(frame.width - safe.left - safe.right) * 0.76}
        />
      </SceneStage>
    );
  },
});
