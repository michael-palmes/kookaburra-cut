import { defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Blank". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the empty scaffold, theme background only.
 */
export default defineScene({
  id: "lab-kind-blank",
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
