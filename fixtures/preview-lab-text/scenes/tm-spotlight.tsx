import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Preview Lab — text-motion sample for the "spotlight" preset. DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview clips
 * (src/assets/option-previews/). The preset itself lives in the SIDECAR textAnimation,
 * exactly as the app's Text-motion panel writes it.
 */
export default defineScene({
  id: "lab-tm-spotlight",
  durationMs: 1600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Built for the way you work");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          from={150}
          to={850}
          position={[0, 0, 0]}
          fontSize={portrait ? 0.26 : 0.44}
        />
      </SceneStage>
    );
  },
});
