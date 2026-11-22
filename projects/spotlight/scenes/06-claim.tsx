import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useBeatGrid,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const TITLE_AT: [number, number, number] = [-0.6, -0.4, -4.2];

export default defineScene({
  id: "spotlight-06-claim",
  durationMs: 1875,
  Scene() {
    const grid = useBeatGrid();
    const { motion } = useTheme();
    const title = useSceneText("title", "");
    return (
      <SceneStage floorY={FLOOR_Y}>
        <AnimatedHeadline
          text={title}
          textKey="title"
          hitAt={grid?.at(11, 1) ?? 0}
          to={motion.durations.fast}
          emphasisAt={grid?.at(11, 3) ?? 938}
          fontSize={0.44}
          fit="width"
          maxWidth={6.2}
          position={TITLE_AT}
        />
      </SceneStage>
    );
  },
});
