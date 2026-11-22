import {
  AnimatedHeadline,
  defineScene,
  ImageCard,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const ICON_AT: [number, number, number] = [0, 0.18, -4.2];
const ICON_WIDTH = 1.05;
const NAME_AT: [number, number, number] = [0, -0.92, -4.2];
const CALL_AT: [number, number, number] = [0, -1.5, -4.2];
const CALL_LEAD_MS = 500;

export default defineScene({
  id: "spotlight-08-lockup",
  durationMs: 3750,
  Scene() {
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { motion } = useTheme();
    const name = useSceneText("name", "");
    const call = useSceneText("title", "");
    const nameAt = grid?.at(15, 3) ?? 938;
    const callAt = grid?.at(16, 1) ?? 1875;
    const land = ramp(localMs, 0, motion.durations.base, "outCubic");
    return (
      <SceneStage floorY={FLOOR_Y}>
        <group
          position={[ICON_AT[0], ICON_AT[1] + 0.28 * (1 - land), ICON_AT[2]]}
          scale={1.08 - 0.08 * land}
        >
          <ImageCard
            src="assets/app-icon.png"
            width={ICON_WIDTH}
            from={0}
            to={motion.durations.fast}
          />
        </group>
        <group visible={localMs >= nameAt - CALL_LEAD_MS}>
          <AnimatedHeadline
            text={name}
            textKey="name"
            hitAt={nameAt}
            to={motion.durations.base}
            fontSize={0.66}
            position={NAME_AT}
          />
        </group>
        <group visible={localMs >= callAt - CALL_LEAD_MS}>
          <AnimatedHeadline
            text={call}
            textKey="title"
            hitAt={callAt}
            to={motion.durations.fast}
            fontSize={0.27}
            position={CALL_AT}
          />
        </group>
      </SceneStage>
    );
  },
});
