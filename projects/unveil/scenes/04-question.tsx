import {
  AnimatedHeadline,
  defineScene,
  useBeatGrid,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-04-question",
  durationMs: 3750,
  Scene() {
    const { frame, safe } = useFormat();
    const grid = useBeatGrid();
    const question = useSceneText("title", "Your week, planned for you.");
    // A word lands on each beat from the cut, so the line follows whatever song the film carries.
    const beatMs = Math.round(grid?.beatMs ?? 469);

    return (
      <AnimatedHeadline
        text={question}
        textKey="title"
        stagger="word"
        staggerMs={beatMs}
        hitAt={0}
        fontSize={0.8}
        fit="width"
        maxWidth={(frame.width - safe.left - safe.right) * 0.84}
      />
    );
  },
});
