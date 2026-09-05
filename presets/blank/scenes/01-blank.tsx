import { defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

export default defineScene({
  id: "blank",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
      </SceneStage>
    );
  },
});
