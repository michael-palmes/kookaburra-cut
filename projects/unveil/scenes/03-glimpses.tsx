import { Device, defineScene, SceneStage, useSceneDevices } from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-03-glimpses",
  durationMs: 7500,
  Scene() {
    const devices = useSceneDevices();
    return (
      <SceneStage>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
      </SceneStage>
    );
  },
});
