import {
  defineScene,
  ExtrudedText,
  IconTile,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -1.905;
const SIZE = 1.5;
const DEPTH = 0.36;
const EDGE = 0.06;
const HALF_DEPTH = (SIZE * (DEPTH + 2 * EDGE)) / 2;
const TILE = 0.88;
const YAW = -0.2;
const NUMERALS_X = -0.55;
const TILE_X = 1.8;

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
        <group position={[0, FLOOR_Y, 0]} rotation={[0, YAW, 0]}>
          <group position={[NUMERALS_X, 0, HALF_DEPTH]} rotation={[tip, 0, 0]} scale={hit}>
            <ExtrudedText
              text={version}
              textKey="title"
              from={0}
              to={0}
              fontSize={SIZE}
              depth={SIZE * DEPTH}
              bevel={{ size: 0.05, thickness: EDGE, segments: 10, corner: 0.07 }}
              finish={{ roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 }}
              shadow
              anchorY="bottom"
              position={[0, 0, -HALF_DEPTH]}
            />
          </group>
          <IconTile
            src="assets/app-icon.png"
            size={TILE}
            depth={TILE * 0.3}
            shadow
            position={[TILE_X, TILE / 2 + drop * 4.5, 0]}
            rotation={[0, 0, -0.5 * drop]}
          />
        </group>
      </SceneStage>
    );
  },
});
