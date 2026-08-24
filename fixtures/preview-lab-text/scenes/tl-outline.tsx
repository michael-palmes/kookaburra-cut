import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Preview Lab — text-look sample for the "outline" preset. DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview clips
 * (src/assets/option-previews/). The look itself lives in the SIDECAR textLook,
 * exactly as the app's Text-style panel writes it; the plain fade keeps the card
 * selling the style, not the motion.
 */
export default defineScene({
  id: "lab-tl-outline",
  durationMs: 1600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "BLUEPRINT");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          from={150}
          to={850}
          position={[0, 0, 0]}
          fontSize={portrait ? 0.34 : 0.6}
        />
      </SceneStage>
    );
  },
});
