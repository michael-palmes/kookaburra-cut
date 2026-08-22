import { Chart, defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

export default defineScene({
  id: "lab-chart-nightEditorial",
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
