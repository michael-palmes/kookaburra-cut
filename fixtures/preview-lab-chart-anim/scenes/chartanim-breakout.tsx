import { Chart, defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

/**
 * Preview Lab: chart build-in card for "Breakout". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker clips;
 * the preset itself lives in the SIDECAR `chart.animation.preset`, exactly as the app's
 * Build-in grid writes it, over 3D columns.
 */
export default defineScene({
  id: "lab-chartanim-breakout",
  durationMs: 2500,
  Scene() {
    const theme = useTheme();
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        <Chart />
      </SceneStage>
    );
  },
});
