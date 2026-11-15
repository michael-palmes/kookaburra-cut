import { Device, defineScene, SceneStage, useSceneDevices } from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-16-montage",
  durationMs: 7500,
  Scene() {
    const devices = useSceneDevices();
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
      </SceneStage>
    );
  },
});
