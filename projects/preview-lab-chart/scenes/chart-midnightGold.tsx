import { Chart, defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

/**
 * Preview Lab: chart appearance card for "Midnight gold". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker stills;
 * the preset itself lives in the SIDECAR `chart.style.preset`, exactly as the app's
 * Appearance carousel writes it, over 3D columns.
 */
export default defineScene({
  id: "lab-chart-midnightGold",
  durationMs: 2400,
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
