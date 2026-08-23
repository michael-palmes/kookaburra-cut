import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Scene 5: the payoff stat. The label and unit come from the sidecar; the number is the one accent. */
export default defineScene({
  id: "subscriber-feature-drop-05-value-counter",
  durationMs: 3200,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Saves about");
    const unit = useSceneText("unit", "min a week");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
          position={[0, portrait ? 0.72 : 0.8, 0]}
          fontSize={portrait ? 0.18 : 0.24}
          defaultColor="muted"
        />
        <AnimatedCounter
          from={0}
          to={40}
          durationMs={1400}
          format={(n) => `${Math.round(n)}`}
          position={[0, portrait ? -0.02 : 0, 0]}
          fontSize={portrait ? 0.5 : 0.9}
        />
        <AnimatedHeadline
          text={unit}
          textKey="unit"
          face="body"
          defaultColor="muted"
          from={1150}
          to={1700}
          position={[0, portrait ? -0.66 : -0.76, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
      </SceneStage>
    );
  },
});
