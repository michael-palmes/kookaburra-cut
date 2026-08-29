import { Device, defineScene, useFormat, useSceneDevices, useTheme } from "@kookaburra/toolkit";

/**
 * Preview Lab, the device-shadow sample for the "backlight" mode. DEV-ONLY: rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed picker preview stills
 * (src/assets/option-previews/). UNSTAGED on purpose: a map-shadowed stage adds a real
 * key-light shadow that drowns the presentation modes. The mode itself lives in the
 * SIDECAR, exactly as the app's Shadow picker writes it.
 */
export default defineScene({
  id: "lab-shadow-backlight",
  durationMs: 1000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const devices = useSceneDevices();
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
            }}
          />
        ))}
      </group>
    );
  },
});
