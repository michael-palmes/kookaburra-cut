import {
  Device,
  defineScene,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useSceneDevices,
} from "@kookaburra/toolkit";

const BAR = 12;
const FLOOR_Y = -1.905;
const CARD: [number, number, number, number] = [0.04, 0.27, 0.96, 0.444];
const RESULT: [number, number, number, number] = [0.035, 0.172, 0.965, 0.24];
const RESULT_BEAT = 2;

export default defineScene({
  id: "release-reel-08-detail-2",
  durationMs: 1875,
  Scene() {
    const devices = useSceneDevices();
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const grid = useBeatGrid();
    const at = (beat: number) => (grid ? grid.bar(BAR, beat) : (beat - 1) * 468.75);
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion
              rect={CARD}
              at={-2000}
              lift={0.07}
              scale={1.03}
              cornerRadius={0.075}
              shadow={0.5}
              outAt={at(1)}
              outDurationMs={320}
            />
            <ScreenRegion
              rect={RESULT}
              at={at(RESULT_BEAT)}
              durationMs={420}
              lift={0.2}
              scale={1.08}
              shadow={0.5}
            />
          </Device>
        ) : null}
        {devices.map((d) => (d === hero ? null : <Device key={d.id} {...d} />))}
      </SceneStage>
    );
  },
});
