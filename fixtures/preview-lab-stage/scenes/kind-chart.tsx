import {
  AnimatedHeadline,
  Chart,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Chart". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed kind-picker stills;
 * mirrors the scaffolded chart scene (the sidecar's chart block under a managed optional title)
 * with the scaffolder's current defaults.
 */
export default defineScene({
  id: "lab-kind-chart",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={900}
            position={[0, portrait ? 1.9 : 1.72, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        <Chart />
      </SceneStage>
    );
  },
});
