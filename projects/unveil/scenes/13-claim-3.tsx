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

// Animatic card: the bars this scene owns, its music hits, and every planned change, lit on its beat.
const FROM_BAR = 21;
const TO_BAR = 22;
const HITS: [number, number][] = [];
const LINES: [number, number][] = [
  [21, 1],
  [21, 3],
];
const EXTRA: [number, number][] = [];
const TITLE_AT: [number, number] | null = [21, 1];
const TITLE_MODE = "stamp" as "stamp" | "word";
const MODE = "list" as "list" | "single";

export default defineScene({
  id: "unveil-13-claim-3",
  durationMs: 1875,
  Scene() {
    const time = useTimeline();
    const { frame, safe } = useFormat();
    const { colors } = useTheme();
    const grid = useBeatGrid();
    const label = useSceneText("label", "", "embedded");
    const bars = useSceneText("bars", "", "embedded");
    const title = useSceneText("title", "");
    const note = useSceneText("note", "", "embedded");
    const e1 = useSceneText("e1", "", "embedded");
    const lines: [string, string][] = [
      ["note", note],
      ["e1", e1],
    ];

    const left = -frame.width / 2 + safe.left;
    const right = frame.width / 2 - safe.right;
    const top = frame.height / 2 - safe.top;
    const bottom = -frame.height / 2 + safe.bottom;
    const width = right - left;
    const card = liftColour(colors.background, colors.text, 0.1);
    const rail = liftColour(colors.background, colors.text, 0.24);

    const perBar = grid?.beatsPerBar ?? 4;
    const span = TO_BAR - FROM_BAR;
    const at = (bar: number, beat = 1) => (grid ? grid.bar(bar, beat) : 0);
    const startMs = at(FROM_BAR);
    const endMs = grid ? at(TO_BAR) : 1;
    const progress = grid ? clamp01((time.localMs - startMs) / (endMs - startMs)) : 0;
    const lineMs = LINES.map(([bar, beat]) => at(bar, beat));
    const titleMs = TITLE_AT ? at(TITLE_AT[0], TITLE_AT[1]) : 0;
    const titleWords = title ? title.split(/\s+/).filter(Boolean).length : 0;
    const wordMs =
      TITLE_AT && TITLE_MODE === "word"
        ? Array.from({ length: titleWords }, (_, i) => titleMs + i * (grid?.beatMs ?? 469))
        : TITLE_AT
          ? [titleMs]
          : [];
    const changeMs = [
      ...lineMs.slice(1),
      ...EXTRA.map(([bar, beat]) => at(bar, beat)),
      ...wordMs.filter((ms) => ms > startMs + 1),
    ];
    let active = 0;
    for (let i = 0; i < lineMs.length; i++) if (time.localMs >= lineMs[i] - 1) active = i;
    const kick = 1 + 0.025 * pulse(time, changeMs, { attackMs: 17, holdMs: 40, releaseMs: 320 });

    const railY = bottom + 0.08;
    const railLeft = left + 0.82;
    const railWidth = right - railLeft;
    const xAtMs = (ms: number) =>
      railLeft + railWidth * clamp01((ms - startMs) / (endMs - startMs));
    const xAt = (bar: number, beat = 1) =>
      railLeft + (railWidth * (bar - FROM_BAR + (beat - 1) / perBar)) / span;
    const fill = Math.max(railWidth * progress, 0.03);
    const barLines = Array.from({ length: span + 1 }, (_, i) => FROM_BAR + i);
    const beatsInBar = Array.from({ length: perBar }, (_, i) => i + 1);
    const beatTimes = (beat: number) =>
      grid ? Array.from({ length: span }, (_, i) => grid.bar(FROM_BAR + i, beat)) : [];
    const listSize = title ? 0.15 : 0.24;
    const listStep = listSize * 1.45;
    const listTop = title
      ? railY + 0.3 + (lines.length - 1) * listStep
      : 0.12 + ((lines.length - 1) * listStep) / 2;

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
        <group scale={[kick, kick, 1]}>
          {title ? (
            <AnimatedHeadline
              text={title}
              textKey="title"
              preset={TITLE_MODE === "word" ? "build" : "stamp"}
              stagger="word"
              staggerMs={TITLE_MODE === "word" ? Math.round(grid?.beatMs ?? 469) : 0}
              hitAt={titleMs}
              fontSize={0.72}
              fit="width"
              maxWidth={width * 0.9}
              position={[0, 0.12, 0.01]}
            />
          ) : null}
          {MODE === "single" ? (
            <AnimatedHeadline
              key={`line-${active}`}
              text={lines[active][1]}
              textKey={lines[active][0]}
              managedTextRole="embedded"
              preset="static"
              face="headline"
              defaultColor="text"
              fontSize={0.6}
              position={[0, 0.12, 0.01]}
            />
          ) : (
            lines.map(([key, text], i) => (
              <AnimatedHeadline
                key={key}
                text={text}
                textKey={key}
                managedTextRole="embedded"
                preset="static"
                face="body"
                defaultColor={i === active ? "text" : "muted"}
                opacity={i === active ? 1 : i < active ? 0.55 : 0.32}
                fontSize={listSize}
                maxWidth={title ? width * 0.8 : width * 0.74}
                anchorX={title ? "left" : "center"}
                anchorY="middle"
                textAlign={title ? "left" : "center"}
                position={[title ? left : 0, listTop - i * listStep, 0.01]}
              />
            ))
          )}
        </group>
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
        {changeMs.map((ms) => (
          <Pill
            key={`change-${Math.round(ms)}`}
            width={0.05}
            height={0.05}
            color={time.localMs >= ms - 1 ? colors.accent : rail}
            position={[xAtMs(ms), railY - 0.1, 0.012]}
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
