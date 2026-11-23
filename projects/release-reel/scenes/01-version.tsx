import {
  DustBurst,
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
const EDGE = 0.026;
const HALF_DEPTH = (SIZE * (DEPTH + 2 * EDGE)) / 2;
const TILE = 0.88;
const YAW = -0.2;
const TILE_X = -2;
const NUMERALS_X = 0.5;
const NUMERALS_WIDTH = 3.3;
const FALL = 5.5;
const FALL_MS = 300;

export default defineScene({
  id: "release-reel-01-version",
  durationMs: 3765,
  Scene() {
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const version = useSceneText("title", "2.4");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - 1) * 4 + beat - 1) * 468.75;
    const land = at(2);
    const fall = FALL * (1 - ramp(localMs, land - FALL_MS, land, "inCubic"));
    const rebound = 0.03 * Math.sin(Math.PI * ramp(localMs, land, land + 130, "linear"));
    const jolt = 0.05 * Math.sin(Math.PI * ramp(localMs, land + 15, land + 215, "linear"));
    const tip = 0.16 * ramp(localMs, at(2, 3), at(3), "inOutSine");
    return (
      <SceneStage floorY={FLOOR_Y}>
        <group position={[0, FLOOR_Y, 0]} rotation={[0, YAW, 0]}>
          <IconTile
            src="assets/app-icon.png"
            size={TILE}
            depth={TILE * 0.3}
            bevel={0.05}
            finish={{ clearcoatRoughness: 0.3 }}
            shadow
            position={[TILE_X, TILE / 2 + jolt, 0]}
          />
          <group position={[NUMERALS_X, fall + rebound, HALF_DEPTH]} rotation={[tip, 0, 0]}>
            <ExtrudedText
              text={version}
              textKey="title"
              from={0}
              to={0}
              fontSize={SIZE}
              depth={SIZE * DEPTH}
              bevel={{ size: 0.022, thickness: EDGE, segments: 8, corner: 0.03 }}
              finish={{ roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.3 }}
              shadow
              anchorY="bottom"
              position={[0, 0, -HALF_DEPTH]}
            />
          </group>
          <DustBurst
            at={land}
            position={[NUMERALS_X, 0, 0]}
            footprint={[NUMERALS_WIDTH, 2 * HALF_DEPTH]}
            count={220}
            seed={7}
            reach={2}
            lift={0.18}
            size={0.6}
            flatten={0.45}
            durationMs={800}
            opacity={0.14}
          />
        </group>
      </SceneStage>
    );
  },
});
