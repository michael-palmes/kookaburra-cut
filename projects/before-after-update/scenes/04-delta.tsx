import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Before / After Update 4: the delta, nine taps counting down to three. */
export default defineScene({
  id: "before-after-update-04-delta",
  durationMs: 2400,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Same job");
    const unit = useSceneText("unit", "taps");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          face="body"
          defaultColor="muted"
          from={200}
          to={900}
          position={[0, portrait ? 0.7 : 0.94, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
        <AnimatedCounter
          from={9}
          to={3}
          durationMs={1200}
          position={[0, 0, 0]}
          fontSize={portrait ? 0.66 : 1.15}
        />
        <AnimatedHeadline
          text={unit}
          textKey="unit"
          face="body"
          defaultColor="muted"
          from={600}
          to={1150}
          position={[0, portrait ? -0.7 : -0.94, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
      </SceneStage>
    );
  },
});
