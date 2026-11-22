import {
  AnimatedCounter,
  AnimatedHeadline,
  Device,
  defineScene,
  Pill,
  RoundedRect,
  ramp,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useProjectShared,
  useSceneDevices,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -2;
const LEFT_X = -5.3;
const DEPTH = -4.2;
const CLOCK_RADIUS = 0.72;
const CLOCK_AT: [number, number, number] = [LEFT_X + CLOCK_RADIUS, 0.02, DEPTH];
const START_HOUR = 1;
const ROW_Y = -1.18;
const CAPTION_Y = -1.6;
const FIGURE_SIZE = 0.42;
const UNIT_GAP = 0.33;
const CAPTION_LEAD_MS = 700;
const ARC_STEPS = 24;
const HOURS = Array.from({ length: 12 }, (_, i) => i);
const ARC = Array.from({ length: ARC_STEPS }, (_, i) => i);

const turn = (deg: number): [number, number, number] => [0, 0, (-deg * Math.PI) / 180];

export default defineScene({
  id: "spotlight-07-proof",
  durationMs: 5625,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { colors, motion } = useTheme();
    const figure = useSceneText("figure", "0", "embedded");
    const unit = useSceneText("unit", "", "embedded");
    const caption = useSceneText("caption", "");
    const card = useProjectShared<[number, number, number, number]>(
      "proof.rect",
      [0.05, 0.2, 0.95, 0.35],
    );
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const hours = Math.max(Number(figure) || 0, 0);
    const sweepFrom = grid?.at(12, 2) ?? 469;
    const sweepTo = grid?.at(13, 3) ?? 2812;
    const liftAt = sweepTo - 420;
    const captionAt = grid?.at(13, 4) ?? 3281;
    const appear = ramp(localMs, 0, motion.durations.base, "outCubic");
    const sweep = ramp(localMs, sweepFrom, sweepTo, "inOutSine");
    const span = 30 * hours;
    const hourDeg = 30 * START_HOUR + span * sweep;
    const minuteDeg = 360 * hours * sweep;
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion
              rect={card}
              at={liftAt}
              durationMs={620}
              scale={1.75}
              offset={[-0.36, 0]}
            />
          </Device>
        ) : null}
        <group position={CLOCK_AT} scale={0.9 + 0.1 * appear} visible={appear > 0}>
          <Pill
            width={2 * CLOCK_RADIUS}
            height={2 * CLOCK_RADIUS}
            color={colors.text}
            opacity={0.1 * appear}
            position={[0.035, -0.05, -0.008]}
          />
          <Pill
            width={2 * CLOCK_RADIUS}
            height={2 * CLOCK_RADIUS}
            color={colors.background}
            opacity={appear}
            strokeWidth={0.035}
            strokeColor={colors.text}
          />
          {HOURS.map((h) => (
            <group key={h} rotation={turn(30 * h)}>
              <RoundedRect
                width={0.028}
                height={h % 3 === 0 ? 0.14 : 0.08}
                radius={0.014}
                color={colors.text}
                opacity={0.55 * appear}
                position={[0, CLOCK_RADIUS - 0.17, 0.002]}
              />
            </group>
          ))}
          {ARC.map((i) => {
            const at = 30 * START_HOUR + (span * (i + 0.5)) / ARC_STEPS;
            const lit = hourDeg >= at ? 1 : 0;
            return (
              <group key={i} rotation={turn(at)} visible={lit > 0}>
                <RoundedRect
                  width={((span * Math.PI) / 180 / ARC_STEPS) * CLOCK_RADIUS * 1.5}
                  height={0.075}
                  radius={0.03}
                  color={colors.accent}
                  opacity={lit * appear}
                  position={[0, CLOCK_RADIUS - 0.035, 0.004]}
                />
              </group>
            );
          })}
          <group rotation={turn(hourDeg)}>
            <RoundedRect
              width={0.065}
              height={0.44}
              radius={0.03}
              color={colors.text}
              opacity={appear}
              position={[0, 0.16, 0.006]}
            />
          </group>
          <group rotation={turn(minuteDeg)}>
            <RoundedRect
              width={0.04}
              height={0.62}
              radius={0.02}
              color={colors.accent}
              opacity={appear}
              position={[0, 0.25, 0.008]}
            />
          </group>
          <Pill
            width={0.12}
            height={0.12}
            color={colors.text}
            opacity={appear}
            position={[0, 0, 0.01]}
          />
        </group>
        <group visible={localMs >= sweepFrom}>
          <AnimatedCounter
            from={0}
            to={hours}
            startMs={sweepFrom}
            durationMs={sweepTo - sweepFrom}
            ease="inOutSine"
            steps={Math.max(Math.round(hours), 1)}
            textKey="figure"
            fontSize={FIGURE_SIZE}
            anchorX="left"
            position={[LEFT_X, ROW_Y, DEPTH]}
          />
          <AnimatedHeadline
            text={unit}
            textKey="unit"
            managedTextRole="embedded"
            preset="static"
            fontSize={FIGURE_SIZE}
            anchorX="left"
            textAlign="left"
            position={[LEFT_X + UNIT_GAP, ROW_Y, DEPTH]}
          />
        </group>
        <group visible={localMs >= captionAt - CAPTION_LEAD_MS}>
          <AnimatedHeadline
            text={caption}
            textKey="caption"
            hitAt={captionAt}
            to={motion.durations.base}
            fontSize={0.22}
            anchorX="left"
            textAlign="left"
            position={[LEFT_X, CAPTION_Y, DEPTH]}
          />
        </group>
      </SceneStage>
    );
  },
});
