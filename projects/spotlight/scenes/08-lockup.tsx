import {
  AnimatedHeadline,
  Device,
  defineScene,
  ImageCard,
  liftColour,
  Pill,
  RoundedRect,
  ramp,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useProjectShared,
  useSceneDevices,
  useSceneText,
  useTextMetrics,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const CENTRE_X = 6.67;
const DEPTH = -2.5;
const VEIL_DEPTH = -5;
const VEIL_OPACITY = 0.62;
const ROW_Y = -0.48;
const CALL_Y = -1.26;
const ICON_WIDTH = 0.76;
const NAME_SIZE = 0.66;
const GAP = 0.28;
const TRACK_WIDTH = 1.08;
const TRACK_HEIGHT = 0.6;
const KNOB = 0.48;
const SETTLED_MS = 1234;

export default defineScene({
  id: "spotlight-08-lockup",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { colors } = useTheme();
    const card = useProjectShared<[number, number, number, number]>(
      "proof.rect",
      [0.05, 0.2, 0.95, 0.35],
    );
    const name = useSceneText("name", "");
    const call = useSceneText("title", "");
    const box = useTextMetrics("name", name, { fontSize: NAME_SIZE });
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const flipAt = grid?.at(16, 1) ?? 1875;
    const nameWidth = box?.width ?? 0;
    const total = ICON_WIDTH + GAP + nameWidth + GAP + TRACK_WIDTH;
    const left = CENTRE_X - total / 2;
    const calm = ramp(localMs, SETTLED_MS, flipAt, "inOutSine");
    const on = ramp(localMs, flipAt - 90, flipAt + 150, "outCubic");
    const said = ramp(localMs, flipAt - 60, flipAt + 180, "outCubic");
    const travel = (TRACK_WIDTH - TRACK_HEIGHT) / 2;
    const trackX = left + ICON_WIDTH + GAP + nameWidth + GAP + TRACK_WIDTH / 2;
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion rect={card} at={-2000} scale={1.75} offset={[-0.36, 0]} />
          </Device>
        ) : null}
        <group visible={calm > 0}>
          <RoundedRect
            width={40}
            height={24}
            color={colors.background}
            opacity={VEIL_OPACITY * calm}
            position={[CENTRE_X, 0, VEIL_DEPTH]}
          />
        </group>
        <group position={[left + ICON_WIDTH / 2, ROW_Y, DEPTH]}>
          <ImageCard src="assets/app-icon.png" width={ICON_WIDTH} holdFocus />
        </group>
        <AnimatedHeadline
          text={name}
          textKey="name"
          preset="static"
          fontSize={NAME_SIZE}
          anchorX="left"
          textAlign="left"
          position={[left + ICON_WIDTH + GAP, ROW_Y, DEPTH]}
        />
        <group position={[trackX, ROW_Y, DEPTH]}>
          <Pill
            width={TRACK_WIDTH}
            height={TRACK_HEIGHT}
            color={liftColour(colors.background, colors.text, 0.2)}
            holdFocus
          />
          <group visible={on > 0}>
            <Pill
              width={TRACK_WIDTH}
              height={TRACK_HEIGHT}
              color={colors.accent}
              opacity={on}
              position={[0, 0, 0.002]}
            />
          </group>
          <Pill
            width={KNOB}
            height={KNOB}
            color={colors.text}
            opacity={0.16}
            position={[-travel + 2 * travel * on + 0.02, -0.03, 0.004]}
          />
          <Pill
            width={KNOB}
            height={KNOB}
            color={colors.background}
            position={[-travel + 2 * travel * on, 0, 0.006]}
          />
        </group>
        <group visible={said > 0}>
          <AnimatedHeadline
            text={call}
            textKey="title"
            preset="static"
            opacity={said}
            fontSize={0.25}
            position={[CENTRE_X, CALL_Y, DEPTH]}
          />
        </group>
      </SceneStage>
    );
  },
});
