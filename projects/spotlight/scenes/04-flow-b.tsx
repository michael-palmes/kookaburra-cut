import { Device, defineScene, SceneStage, useSceneDevices } from "@kookaburra/toolkit";

const FLOOR_Y = -2;

export default defineScene({
  id: "spotlight-04-flow-b",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    return <SceneStage floorY={FLOOR_Y}>{hero ? <Device {...hero} /> : null}</SceneStage>;
  },
});
