import { Device, defineScene, SceneStage, useFormat, useSceneDevices } from "@kookaburra/toolkit";

export default defineScene({
  id: "redesign-reveal-05-screens-arc",
  durationMs: 4000,
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
