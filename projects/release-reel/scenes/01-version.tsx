import {
  defineScene,
  ExtrudedText,
  ImageCard,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -1.905;
const SIZE = 1.5;
const ICON = 1.2;

export default defineScene({
  id: "release-reel-01-version",
  durationMs: 3765,
  Scene() {
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const version = useSceneText("title", "2.4");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - 1) * 4 + beat - 1) * 468.75;
    const hit = 1 + 0.14 * (1 - ramp(localMs, at(1), at(1) + 380, "outCubic"));
    const tip = 0.16 * ramp(localMs, at(2, 3), at(3), "inOutSine");
    const drop = 1 - ramp(localMs, at(2) - 260, at(2), "inCubic");
    return (
      <SceneStage floorY={FLOOR_Y}>
        <group position={[-1.0, FLOOR_Y, 0]} rotation={[tip, 0, 0]} scale={hit}>
          <ExtrudedText
            text={version}
            textKey="title"
            from={0}
            to={0}
            fontSize={SIZE}
            position={[0, SIZE * 0.385, 0]}
          />
        </group>
        <ImageCard
          src="assets/app-icon.png"
          width={ICON}
          position={[1.75, FLOOR_Y + ICON / 2 + 0.02 + drop * 4.5, 0.2]}
        />
      </SceneStage>
    );
  },
});
