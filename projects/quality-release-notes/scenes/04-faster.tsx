import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Scene 4: the payoff stat. The label and unit come from the sidecar; the counter is the one accent. */
export default defineScene({
  id: "quality-release-notes-04-faster",
  durationMs: 2800,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Cold start");
    const unit = useSceneText("unit", "s");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
          position={[0, portrait ? 0.6 : 0.74, 0]}
          fontSize={portrait ? 0.18 : 0.24}
          defaultColor="muted"
        />
        <AnimatedCounter
          from={2.4}
          to={0.9}
          durationMs={1400}
          format={(n) => `${n.toFixed(1)}${unit}`}
          position={[0, portrait ? -0.16 : -0.12, 0]}
          fontSize={portrait ? 0.5 : 0.9}
        />
      </SceneStage>
    );
  },
});
