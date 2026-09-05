import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/** Preset: the payoff stat, a big number counting down between two supporting lines. */
export default defineScene({
  id: "preset-stat-counter",
  durationMs: 3400,
  Scene() {
    const theme = useTheme();
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
          defaultColor="text"
          from={200}
          to={900}
          position={[0, portrait ? 0.5 : 0.72, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
        <AnimatedCounter
          from={12}
          to={2}
          durationMs={theme.motion.durations.slow * 2}
          position={[0, 0, 0]}
          fontSize={portrait ? 0.5 : 0.95}
        />
        <AnimatedHeadline
          text={unit}
          textKey="unit"
          face="body"
          defaultColor="text"
          from={1500}
          to={2200}
          position={[0, portrait ? -0.5 : -0.68, 0]}
          fontSize={portrait ? 0.18 : 0.24}
        />
      </SceneStage>
    );
  },
});
