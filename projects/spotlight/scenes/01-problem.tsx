import {
  AnimatedHeadline,
  Device,
  defineScene,
  liftColour,
  RoundedRect,
  ramp,
  SceneStage,
  ScreenLayer,
  useBeatGrid,
  useFormat,
  useSceneDevices,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const TITLE_AT: [number, number, number] = [2, -0.5, -4.2];
const STACK_AT: [number, number, number] = [7.2, -0.55, -4.2];
const CARD_WIDTH = 2.4;
const CARD_HEIGHT = 0.5;
const CARD_PITCH = 0.44;
const CARD_LEAD_MS = 120;
const FADE_IN_MS = 700;
const SLOTS: [number, number][] = [
  [-0.06, 1.4],
  [0.08, -1.1],
  [-0.09, 0.8],
  [0.07, -1.5],
  [-0.02, 1.1],
];

export default defineScene({
  id: "spotlight-01-problem",
  durationMs: 3749,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { frame } = useFormat();
    const { colors, chartColors, motion } = useTheme();
    const tints = chartColors?.length ? chartColors : [colors.accent];
    const title = useSceneText("title", "");
    const plan1 = useSceneText("plan1", "", "embedded");
    const plan2 = useSceneText("plan2", "", "embedded");
    const plan3 = useSceneText("plan3", "", "embedded");
    const plan4 = useSceneText("plan4", "", "embedded");
    const plan5 = useSceneText("plan5", "", "embedded");
    const plans = [
      { key: "plan1", text: plan1 },
      { key: "plan2", text: plan2 },
      { key: "plan3", text: plan3 },
      { key: "plan4", text: plan4 },
      { key: "plan5", text: plan5 },
    ];
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const stepMs = Math.round((grid?.beatMs ?? 469) / 2);
    const titleAt = grid?.at(1, 2) ?? 469;
    const veil = 1 - ramp(localMs, 0, FADE_IN_MS, "inOutSine");
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? <Device {...hero} /> : null}
        <AnimatedHeadline
          text={title}
          textKey="title"
          stagger="word"
          staggerMs={stepMs}
          hitAt={titleAt}
          to={motion.durations.base}
          fontSize={0.4}
          anchorX="left"
          textAlign="left"
          position={TITLE_AT}
        />
        <group position={STACK_AT}>
          {plans.map((plan, i) => {
            const [dx, tiltDeg] = SLOTS[i];
            const start = CARD_LEAD_MS + i * stepMs;
            const p = ramp(localMs, start, start + motion.durations.base, "outCubic");
            const y = ((plans.length - 1) / 2 - i) * CARD_PITCH + 0.3 * (1 - p);
            const fill = liftColour(colors.background, tints[i % tints.length], 0.26);
            return (
              <group
                key={plan.key}
                position={[dx, y, i * 0.012]}
                rotation={[0, 0, (tiltDeg * Math.PI) / 180]}
              >
                <RoundedRect
                  width={CARD_WIDTH}
                  height={CARD_HEIGHT}
                  radius={0.14}
                  color={colors.text}
                  opacity={0.1 * p}
                  position={[0.03, -0.045, -0.004]}
                />
                <RoundedRect
                  width={CARD_WIDTH}
                  height={CARD_HEIGHT}
                  radius={0.14}
                  color={fill}
                  opacity={p}
                />
                <AnimatedHeadline
                  text={plan.text}
                  textKey={plan.key}
                  managedTextRole="embedded"
                  preset="static"
                  face="body"
                  opacity={p}
                  fontSize={0.19}
                  anchorX="left"
                  textAlign="left"
                  position={[-CARD_WIDTH / 2 + 0.2, 0, 0.004]}
                />
              </group>
            );
          })}
        </group>
        <ScreenLayer order="front">
          <group visible={veil > 0}>
            <RoundedRect
              width={frame.width * 1.2}
              height={frame.height * 1.2}
              color={colors.background}
              opacity={veil}
            />
          </group>
        </ScreenLayer>
      </SceneStage>
    );
  },
});
