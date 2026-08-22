import { AnimatedHeadline, defineScene, useSceneText } from "@kookaburra/toolkit";

// Caption size in world units; the sidecar's textStyle pins, colours and scales it over the capture.
const CAPTION_EM = 0.32;

export default defineScene({
  id: "app-store-preview-30-02-claim-over-capture",
  durationMs: 4400,
  Scene() {
    const title = useSceneText("title", "Plan a week\nin a minute");
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
