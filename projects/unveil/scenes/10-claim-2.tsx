import { AnimatedHeadline, defineScene, useFormat, useSceneText } from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-10-claim-2",
  durationMs: 1875,
  Scene() {
    const { frame, safe } = useFormat();
    const claim = useSceneText("title", "Moves when you do.");

    return (
      <AnimatedHeadline
        text={claim}
        textKey="title"
        hitAt={0}
        fontSize={0.62}
        fit="width"
        maxWidth={(frame.width - safe.left - safe.right) * 0.86}
      />
    );
  },
});
