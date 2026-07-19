import { Device, defineScene, SceneStage, useFormat, useSceneDevices } from "@kookaburra/toolkit";

/**
 * Preview Lab: New-scene kind card for "Device + media". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed kind-picker stills;
 * mirrors the scaffolded device-scene composition with the wizard's default device.
 */
export default defineScene({
  id: "lab-kind-device",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const devices = useSceneDevices();
    return (
      <SceneStage>
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
      </SceneStage>
    );
  },
});
