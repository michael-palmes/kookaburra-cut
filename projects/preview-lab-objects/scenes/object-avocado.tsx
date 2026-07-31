import { defineScene, SceneStage, useTheme } from "@kookaburra/toolkit";

/**
 * Preview Lab: object-picker card for "avocado". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews`; the sidecar stages the bundled object
 * scaled up to fill the card, so the composition stays empty.
 */
export default defineScene({
  id: "lab-object-avocado",
  durationMs: 1000,
  Scene() {
    const theme = useTheme();
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
      </SceneStage>
    );
  },
});
