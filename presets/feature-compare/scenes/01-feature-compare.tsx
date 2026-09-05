import { Device, defineScene, SceneStage, useFormat, useSceneDevices } from "@kookaburra/toolkit";

/** Preset: a before/after wipe across one handset, the divider sweeping the new screen in. */
export default defineScene({
  id: "preset-feature-compare",
  durationMs: 4400,
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
