import { AnimatedHeadline, defineScene, useSceneText } from "@kookaburra/toolkit";

// Caption size in world units; the sidecar's textStyle pins, colours and scales it over the capture.
const CAPTION_EM = 0.32;

export default defineScene({
  id: "app-store-preview-30-03-flow-one",
  durationMs: 3400,
  Scene() {
    const title = useSceneText("title", "One list\na day");
    return (
      <AnimatedHeadline
        text={title}
        textKey="title"
        from={200}
        to={900}
        fontSize={CAPTION_EM}
        textAlign="center"
      />
    );
  },
});
