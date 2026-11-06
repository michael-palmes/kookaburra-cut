import {
  AnimatedHeadline,
  defineScene,
  liftColour,
  Pill,
  pulse,
  RoundedRect,
  sampleKeys,
  useFormat,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const BAR_MS = 1875;
const BEAT_MS = BAR_MS / 4;
const BLOCKS = [2, 3, 3, 2, 4, 3, 3, 4];
const HITS = [2, 3, 4, 5, 6, 7];
const STARTS = BLOCKS.map((_, k) =>
  BLOCKS.slice(0, k).reduce((sum, bars) => sum + bars * BAR_MS, 0),
);
const GLIDE = STARTS.flatMap((start, k) =>
  k === 0
    ? [{ tMs: 0, at: 0 }]
    : [
        { tMs: start - 2 * BEAT_MS, at: k - 1 + 0 },
        { tMs: start, at: k, ease: "inOutBack" },
      ],
);

export default defineScene({
  id: "one-dot-01-one-dot",
  durationMs: 45000,
  Scene() {
    const time = useTimeline();
    const theme = useTheme();
    const { colors } = theme;
    const { frame } = useFormat();
    const labels = [
      useSceneText("label1", "", "embedded"),
      useSceneText("label2", "", "embedded"),
      useSceneText("label3", "", "embedded"),
      useSceneText("label4", "", "embedded"),
      useSceneText("label5", "", "embedded"),
      useSceneText("label6", "", "embedded"),
      useSceneText("label7", "", "embedded"),
      useSceneText("label8", "", "embedded"),
    ];
    const barTexts = [
      useSceneText("bars1", "", "embedded"),
      useSceneText("bars2", "", "embedded"),
      useSceneText("bars3", "", "embedded"),
      useSceneText("bars4", "", "embedded"),
      useSceneText("bars5", "", "embedded"),
      useSceneText("bars6", "", "embedded"),
      useSceneText("bars7", "", "embedded"),
      useSceneText("bars8", "", "embedded"),
    ];
    const copies = [
      useSceneText("copy1"),
      useSceneText("copy2"),
      useSceneText("copy3"),
      useSceneText("copy4"),
      useSceneText("copy5"),
      useSceneText("copy6"),
      useSceneText("copy7"),
      useSceneText("copy8"),
    ];
    const shots = [
      useSceneText("shot1", "", "embedded"),
      useSceneText("shot2", "", "embedded"),
      useSceneText("shot3", "", "embedded"),
      useSceneText("shot4", "", "embedded"),
      useSceneText("shot5", "", "embedded"),
      useSceneText("shot6", "", "embedded"),
      useSceneText("shot7", "", "embedded"),
      useSceneText("shot8", "", "embedded"),
    ];
    const w = frame.width * 0.86;
    const h = frame.height * 0.8;
    const pad = 0.3;
    const y = -h / 2 + pad + 0.06;
    const card = liftColour(colors.background, colors.text, 0.07);
    const edge = liftColour(colors.background, colors.text, 0.18);
    const { at: glide } = sampleKeys(GLIDE, time.localMs);
    return (
      <group position={[-glide * (w + 0.6), 0, 0]}>
        {BLOCKS.map((bars, k) => {
          const start = STARTS[k];
          const n = k + 1;
          const copy = copies[k];
          const hasCopy = copy.trim() !== "";
          const beats = Array.from({ length: bars * 4 }, (_, i) => start + i * BEAT_MS);
          const step = Math.min(0.3, (w - 2 * pad) / (bars * 4.6));
          const x = (i: number) => (i + Math.floor(i / 4) * 0.6) * step;
          const span = x(beats.length - 1);
          const left = -span / 2;
          const at = (time.localMs - start) / BEAT_MS;
          const beat = Math.floor(at);
          const played = Math.max(
            0,
            Math.min(span, x(beat) + (x(beat + 1) - x(beat)) * (at - beat)),
          );
          const tick = pulse(time, beats, { attackMs: 17, releaseMs: 220 });
          const hit = HITS.includes(k) ? pulse(time, start, { attackMs: 17, releaseMs: 700 }) : 0;
          const tone = (i: number) => {
            if (i === beat) return { color: colors.accent, opacity: 1 };
            return i < beat
              ? { color: colors.text, opacity: 0.6 }
              : { color: colors.muted, opacity: 0.35 };
          };
          return (
            <group key={start} position={[k * (w + 0.6), 0, 0]}>
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
                color={card}
                strokeWidth={0.012}
                strokeColor={edge}
              />
              <AnimatedHeadline
                text={labels[k]}
                textKey={`label${n}`}
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
                text={barTexts[k]}
                textKey={`bars${n}`}
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
                  textKey={`copy${n}`}
                  from={start}
                  to={start + theme.motion.durations.base}
                  fontSize={0.5}
                  maxWidth={w - 2 * pad}
                  fit="width"
                  textAlign="center"
                  position={[0, 0.25, 0.01]}
                />
              )}
              <AnimatedHeadline
                text={shots[k]}
                textKey={`shot${n}`}
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
              {HITS.includes(k) && (
                <Pill
                  width={0.2}
                  height={0.2}
                  color={colors.accent}
                  opacity={0.3}
                  position={[left, y, 0.008]}
                />
              )}
              {beats.map((t, i) => {
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
        })}
      </group>
    );
  },
});
