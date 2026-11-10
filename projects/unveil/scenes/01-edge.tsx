import { Device, defineScene, SceneStage, useSceneDevices } from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-01-edge",
  durationMs: 1858,
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
