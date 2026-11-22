import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useProjectShared,
  useSceneDevices,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const TITLE_AT: [number, number, number] = [-4.98, -0.42, -4.2];
const TITLE_LEAD_MS = 700;
const TITLE_OUT_MS = 300;

export default defineScene({
  id: "spotlight-02-name",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const title = useSceneText("title", "");
    const control = useProjectShared<[number, number, number, number]>(
      "control.rect",
      [0.05, 0.3, 0.95, 0.45],
    );
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const liftAt = (grid?.at(3, 2) ?? 469) - 200;
    const titleAt = grid?.at(3, 4) ?? 1406;
    const leaveAt = grid?.at(4, 3) ?? 2812;
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion
              rect={control}
              at={liftAt}
              durationMs={620}
              scale={1.7}
              offset={[-0.3, 0]}
              outAt={leaveAt}
            />
          </Device>
        ) : null}
        <group visible={localMs >= titleAt - TITLE_LEAD_MS && localMs < leaveAt + TITLE_OUT_MS}>
          <AnimatedHeadline
            text={title}
            textKey="title"
            hitAt={titleAt}
            outAt={leaveAt}
            outDurationMs={TITLE_OUT_MS}
            fontSize={0.44}
            anchorX="left"
            textAlign="left"
            position={TITLE_AT}
          />
        </group>
      </SceneStage>
    );
  },
});
