import {
  AnimatedHeadline,
  defineScene,
  liftColour,
  Pill,
  pulse,
  RoundedRect,
  useFormat,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const BEAT_MS = 1875 / 4;
const BARS = 2;
const HITS: number[] = [0];
const BEATS = Array.from({ length: BARS * 4 }, (_, i) => i * BEAT_MS);

export default defineScene({
  id: "then-and-now-05-calmer",
  durationMs: 3750,
  Scene() {
    const time = useTimeline();
    const theme = useTheme();
    const { colors } = theme;
    const { frame } = useFormat();
    const label = useSceneText("label", "", "embedded");
    const barText = useSceneText("bars", "", "embedded");
    const copy = useSceneText("copy");
    const shot = useSceneText("shot", "", "embedded");
    const w = frame.width * 0.86;
    const h = frame.height * 0.8;
    const pad = 0.3;
    const step = Math.min(0.3, (w - 2 * pad) / (BARS * 4.6));
    const x = (i: number) => (i + Math.floor(i / 4) * 0.6) * step;
    const span = x(BEATS.length - 1);
    const left = -span / 2;
    const y = -h / 2 + pad + 0.06;
    const at = time.localMs / BEAT_MS;
    const beat = Math.floor(at);
    const played = Math.min(span, x(beat) + (x(beat + 1) - x(beat)) * (at - beat));
    const tick = pulse(time, BEATS, { attackMs: 17, releaseMs: 220 });
    const hit = pulse(
      time,
      HITS.map((bar) => bar * 4 * BEAT_MS),
      { attackMs: 17, releaseMs: 700 },
    );
    const hasCopy = copy.trim() !== "";
    const tone = (i: number) => {
      if (i === beat) return { color: colors.accent, opacity: 1 };
      return i < beat
        ? { color: colors.text, opacity: 0.6 }
        : { color: colors.muted, opacity: 0.35 };
    };
    return (
      <group>
        {hit > 0 && (
          <RoundedRect
            width={w + 0.1}
            height={h + 0.1}
            radius={0.19}
            color={colors.accent}
            opacity={0.6 * hit}
            position={[0, 0, -0.02]}
          />
        )}
        <RoundedRect
          width={w}
          height={h}
          radius={0.14}
          color={liftColour(colors.background, colors.text, 0.07)}
          strokeWidth={0.012}
          strokeColor={liftColour(colors.background, colors.text, 0.18)}
        />
        <AnimatedHeadline
          text={label}
          textKey="label"
          managedTextRole="embedded"
          face="body"
          defaultColor="muted"
          preset="static"
          fontSize={0.15}
          anchorX="left"
          anchorY="top"
          position={[-w / 2 + pad, h / 2 - pad, 0.01]}
        />
        <AnimatedHeadline
          text={barText}
          textKey="bars"
          managedTextRole="embedded"
          face="body"
          defaultColor="muted"
          preset="static"
          fontSize={0.15}
          anchorX="right"
          anchorY="top"
          position={[w / 2 - pad, h / 2 - pad, 0.01]}
        />
        {hasCopy && (
          <AnimatedHeadline
            text={copy}
            textKey="copy"
            from={0}
            to={theme.motion.durations.base}
            fontSize={0.5}
            maxWidth={w - 2 * pad}
            fit="width"
            textAlign="center"
            position={[0, 0.25, 0.01]}
          />
        )}
        <AnimatedHeadline
          text={shot}
          textKey="shot"
          managedTextRole="embedded"
          face="body"
          defaultColor="muted"
          preset="static"
          fontSize={hasCopy ? 0.15 : 0.22}
          maxWidth={w * 0.8}
          textAlign="center"
          position={[0, hasCopy ? -0.75 : 0.1, 0.01]}
        />
        {played > 0 && (
          <Pill
            width={played}
            height={0.014}
            color={colors.accent}
            opacity={0.5}
            position={[left + played / 2, y, 0.005]}
          />
        )}
        {HITS.map((bar) => (
          <Pill
            key={bar}
            width={0.2}
            height={0.2}
            color={colors.accent}
            opacity={0.3}
            position={[left + x(bar * 4), y, 0.008]}
          />
        ))}
        {BEATS.map((t, i) => {
          const size = i % 4 === 0 ? 0.09 : 0.05;
          return (
            <Pill
              key={t}
              width={size}
              height={size}
              {...tone(i)}
              scale={i === beat ? 1 + 0.5 * tick : 1}
              position={[left + x(i), y, 0.01]}
            />
          );
        })}
      </group>
    );
  },
});
