import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Onboarding Refresh 5: the activation number, label above and the method line below. */
export default defineScene({
  id: "onboarding-refresh-05-activation-stat",
  durationMs: 3400,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Finished setup");
    const unit = useSceneText("unit", "%");
    const note = useSceneText("note");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
          position={[0, portrait ? 0.78 : 0.72, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
        <AnimatedCounter
          from={61}
          to={88}
          durationMs={1800}
          format={(n) => `${Math.round(n)}${unit}`}
          position={[0, portrait ? 0.05 : 0, 0]}
          fontSize={portrait ? 0.46 : 0.84}
        />
        {note ? (
          <AnimatedHeadline
            text={note}
            textKey="note"
            face="body"
            from={1500}
            to={2200}
            position={[0, portrait ? -0.68 : -0.7, 0]}
            fontSize={portrait ? 0.16 : 0.22}
          />
        ) : null}
      </SceneStage>
    );
  },
});
