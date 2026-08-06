import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Feature Deep Dive 6: the payoff stat, counting down to the number that changed. */
export default defineScene({
  id: "feature-deep-dive-06-payoff-counter",
  durationMs: 3400,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Now it takes");
    const unit = useSceneText("unit", "seconds");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          face="body"
          defaultColor="muted"
          from={200}
          to={900}
          position={[0, portrait ? 0.5 : 0.72, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
        <AnimatedCounter
          from={12}
          to={2}
          durationMs={1800}
          position={[0, 0, 0]}
          fontSize={portrait ? 0.5 : 0.95}
        />
        <AnimatedHeadline
          text={unit}
          textKey="unit"
          face="body"
          defaultColor="muted"
          from={1500}
          to={2200}
          position={[0, portrait ? -0.5 : -0.68, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
      </SceneStage>
    );
  },
});
