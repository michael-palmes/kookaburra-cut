import {
  AnimatedHeadline,
  Device,
  defineScene,
  Pill,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
  useTextMetrics,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const LEFT_X = -5.3;
const LEAD_Y = -0.3;
const TITLE_Y = -0.95;
const DEPTH = -4.2;
const LEAD_SIZE = 0.46;
const PILL_PAD = 0.3;
const PILL_HEIGHT = 0.72;
const OUT_MS = 280;

export default defineScene({
  id: "spotlight-06-claim",
  durationMs: 1875,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { colors, motion } = useTheme();
    const lead = useSceneText("lead", "");
    const title = useSceneText("title", "");
    const box = useTextMetrics("lead", lead, { fontSize: LEAD_SIZE });
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const landAt = grid?.at(11, 1) ?? 0;
    const pillAt = grid?.at(11, 3) ?? 938;
    const outAt = (grid?.at(12, 1) ?? 1875) - OUT_MS;
    const fill = ramp(localMs, pillAt, pillAt + motion.durations.base, "outCubic");
    const leave = 1 - ramp(localMs, outAt, outAt + OUT_MS, "inCubic");
    const width = (box?.width ?? 0) + 2 * PILL_PAD;
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? <Device {...hero} /> : null}
        <group visible={fill > 0 && leave > 0}>
          <Pill
            width={width}
            height={PILL_HEIGHT}
            scale={0.94 + 0.06 * fill}
            color={colors.accent}
            opacity={fill * leave}
            position={[LEFT_X - PILL_PAD + width / 2, LEAD_Y, DEPTH - 0.01]}
          />
          <AnimatedHeadline
            text={lead}
            textKey="lead"
            managedTextRole="embedded"
            preset="static"
            color={colors.background}
            opacity={fill * leave}
            fontSize={LEAD_SIZE}
            anchorX="left"
            textAlign="left"
            position={[LEFT_X, LEAD_Y, DEPTH + 0.004]}
          />
        </group>
        <group visible={leave > 0}>
          <AnimatedHeadline
            text={lead}
            textKey="lead"
            hitAt={landAt}
            to={motion.durations.fast}
            opacity={(1 - fill) * leave}
            fontSize={LEAD_SIZE}
            anchorX="left"
            textAlign="left"
            position={[LEFT_X, LEAD_Y, DEPTH]}
          />
          <AnimatedHeadline
            text={title}
            textKey="title"
            hitAt={landAt}
            to={motion.durations.fast}
            opacity={leave}
            fontSize={0.38}
            anchorX="left"
            textAlign="left"
            position={[LEFT_X, TITLE_Y, DEPTH]}
          />
        </group>
      </SceneStage>
    );
  },
});
