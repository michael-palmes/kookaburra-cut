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
const TITLE_AT: [number, number, number] = [-2.95, -0.42, -4.2];
const TITLE_LEAD_MS = 700;

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
    const liftAt = (grid?.at(3, 3) ?? 938) - 420;
    const titleAt = grid?.at(4, 1) ?? 1875;
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
            />
          </Device>
        ) : null}
        <group visible={localMs >= titleAt - TITLE_LEAD_MS}>
          <AnimatedHeadline
            text={title}
            textKey="title"
            hitAt={titleAt}
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
