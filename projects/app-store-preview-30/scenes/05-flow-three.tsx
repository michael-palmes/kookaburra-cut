import { AnimatedHeadline, defineScene, useSceneText } from "@kookaburra/toolkit";

// Caption size in world units; the sidecar's textStyle pins, colours and scales it over the capture.
const CAPTION_EM = 0.32;

export default defineScene({
  id: "app-store-preview-30-05-flow-three",
  durationMs: 4000,
  Scene() {
    const title = useSceneText("title", "Make it\nyours");
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
