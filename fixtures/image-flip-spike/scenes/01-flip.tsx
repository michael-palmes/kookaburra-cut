import { Device, defineScene, SceneStage, useSceneDevices, useTheme } from "@kookaburra/toolkit";

/**
 * Image Flip Spike: one image staged BOTH ways in a single frame, a device screen on the left
 * and a plain stage plane on the right (the sidecar `images` block, rendered host-side). Verify
 * proves determinism, not orientation, so this fixture exists to be eyeballed:
 * `pnpm kookaburra:run --action screenshot --project image-flip-spike`.
 */
export default defineScene({
  id: "image-flip-spike-01",
  durationMs: 1000,
  Scene() {
    const theme = useTheme();
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
      </SceneStage>
    );
  },
});
