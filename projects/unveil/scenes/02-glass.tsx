import { Device, defineScene, SceneStage, useSceneDevices } from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-02-glass",
  durationMs: 1875,
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
