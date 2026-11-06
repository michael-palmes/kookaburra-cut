import {
  AnimatedHeadline,
  clamp01,
  defineScene,
  liftColour,
  Pill,
  pulse,
  RoundedRect,
  useBeatGrid,
  useFormat,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

// Animatic card: the bars this scene owns, the hits it marks, and how its copy builds.
const FROM_BAR = 13;
const TO_BAR = 14;
const HITS: [number, number][] = [[13, 1]];
const PRESET = "slam";
const STAGGER_BEATS = 0.5;

export default defineScene({
  id: "release-reel-09-word-3",
  durationMs: 1875,
  Scene() {
    const time = useTimeline();
    const { frame, safe } = useFormat();
    const { colors } = useTheme();
    const grid = useBeatGrid();
    const label = useSceneText("label", "", "embedded");
    const bars = useSceneText("bars", "", "embedded");
    const kicker = useSceneText("kicker", "", "embedded");
    const title = useSceneText("title", "");
    const note = useSceneText("note", "", "embedded");

    const left = -frame.width / 2 + safe.left;
    const right = frame.width / 2 - safe.right;
    const top = frame.height / 2 - safe.top;
    const bottom = -frame.height / 2 + safe.bottom;
    const width = right - left;
    const card = liftColour(colors.background, colors.text, 0.1);
    const rail = liftColour(colors.background, colors.text, 0.24);

    const perBar = grid?.beatsPerBar ?? 4;
    const span = TO_BAR - FROM_BAR;
    const startMs = grid ? grid.bar(FROM_BAR) : 0;
    const endMs = grid ? grid.bar(TO_BAR) : 1;
    const progress = grid ? clamp01((time.localMs - startMs) / (endMs - startMs)) : 0;
    const railY = bottom + 0.08;
    const railLeft = left + 0.82;
    const railWidth = right - railLeft;
    const xAt = (bar: number, beat = 1) =>
      railLeft + (railWidth * (bar - FROM_BAR + (beat - 1) / perBar)) / span;
    const fill = Math.max(railWidth * progress, 0.03);
    const barLines = Array.from({ length: span + 1 }, (_, i) => FROM_BAR + i);
    const beatsInBar = Array.from({ length: perBar }, (_, i) => i + 1);
    const beatTimes = (beat: number) =>
      grid ? Array.from({ length: span }, (_, i) => grid.bar(FROM_BAR + i, beat)) : [];

    return (
      <group>
        <RoundedRect
          width={frame.width * 1.04}
          height={frame.height * 1.04}
          radius={0}
          color={card}
          position={[0, 0, -0.02]}
        />
        <AnimatedHeadline
          text={label}
          textKey="label"
          managedTextRole="embedded"
          preset="static"
          face="body"
          defaultColor="muted"
          fontSize={0.14}
          anchorX="left"
          textAlign="left"
          position={[left, top - 0.08, 0.01]}
        />
        <AnimatedHeadline
          text={bars}
          textKey="bars"
          managedTextRole="embedded"
          preset="static"
          face="body"
          defaultColor="muted"
          fontSize={0.14}
          anchorX="right"
          textAlign="right"
          position={[right, top - 0.08, 0.01]}
        />
        {title && kicker ? (
          <AnimatedHeadline
            text={kicker}
            textKey="kicker"
            managedTextRole="embedded"
            preset="static"
            face="body"
            defaultColor="muted"
            fontSize={0.18}
            position={[0, 0.78, 0.01]}
          />
        ) : null}
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            preset={PRESET}
            stagger="word"
            staggerMs={Math.round((grid?.beatMs ?? 469) * STAGGER_BEATS)}
            from={0}
            to={420}
            fontSize={0.72}
            fit="width"
            maxWidth={width * 0.9}
            position={[0, 0.12, 0.01]}
          />
        ) : null}
        <AnimatedHeadline
          text={note}
          textKey="note"
          managedTextRole="embedded"
          preset="static"
          face="body"
          defaultColor="muted"
          fontSize={title ? 0.15 : 0.26}
          maxWidth={title ? width * 0.8 : width * 0.74}
          anchorX={title ? "left" : "center"}
          anchorY={title ? "bottom" : "middle"}
          textAlign={title ? "left" : "center"}
          position={title ? [left, railY + 0.3, 0.01] : [0, 0.12, 0.01]}
        />
        {beatsInBar.map((beat) => (
          <group key={`beat-${beat}`} position={[left + 0.05 + (beat - 1) * 0.18, railY, 0.01]}>
            <Pill width={0.1} height={0.1} color={rail} />
            <Pill
              width={0.1}
              height={0.1}
              color={colors.accent}
              opacity={pulse(time, beatTimes(beat), { attackMs: 17, holdMs: 90, releaseMs: 320 })}
              position={[0, 0, 0.001]}
            />
          </group>
        ))}
        <Pill
          width={railWidth}
          height={0.024}
          color={rail}
          position={[railLeft + railWidth / 2, railY, 0.01]}
        />
        <Pill
          width={fill}
          height={0.024}
          color={colors.accent}
          opacity={progress > 0 ? 1 : 0}
          position={[railLeft + fill / 2, railY, 0.011]}
        />
        {barLines.map((bar) => (
          <Pill
            key={`bar-${bar}`}
            width={0.014}
            height={0.12}
            color={rail}
            position={[xAt(bar), railY, 0.012]}
          />
        ))}
        {HITS.map(([bar, beat]) => (
          <RoundedRect
            key={`hit-${bar}-${beat}`}
            width={0.08}
            height={0.08}
            radius={0.012}
            color={colors.accent}
            rotation={[0, 0, Math.PI / 4]}
            scale={
              grid
                ? 1 +
                  0.9 *
                    pulse(time, grid.bar(bar, beat), {
                      attackMs: 17,
                      holdMs: 120,
                      releaseMs: 520,
                    })
                : 1
            }
            position={[xAt(bar, beat), railY + 0.15, 0.013]}
          />
        ))}
      </group>
    );
  },
});
