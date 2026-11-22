import {
  Device,
  defineScene,
  ramp,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useProjectShared,
  useSceneDevices,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;

export default defineScene({
  id: "spotlight-05-close-up",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const from = useProjectShared<[number, number]>("control.timer", [0.3, 0.5]);
    const to = useProjectShared<[number, number]>("control.switch", [0.7, 0.4]);
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const glide = ramp(localMs, grid?.at(9, 4) ?? 1406, grid?.at(10, 1) ?? 1875, "inOutCubic");
    const centre: [number, number] = [
      from[0] + (to[0] - from[0]) * glide,
      from[1] + (to[1] - from[1]) * glide,
    ];
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion
              variant="lens"
              centre={centre}
              radius={0.34}
              zoom={1.6}
              at={0}
              durationMs={380}
            />
          </Device>
        ) : null}
      </SceneStage>
    );
  },
});
