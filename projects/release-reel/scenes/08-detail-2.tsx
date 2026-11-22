import {
  AnimatedHeadline,
  clamp01,
  defineScene,
  Pill,
  pulse,
  RoundedRect,
  useBeatGrid,
  useFormat,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FROM_BAR = 12;
const TO_BAR = 13;
const HITS: [number, number][] = [];
const CHANGES: [number, number][] = [
  [12, 1],
  [12, 3],
];
const TITLE_AT: [number, number] | null = null;
const KICKER_AT: [number, number] | null = null;
const WORD_A_BEAT = false;
const LIGHT_ROOM = false;
const TITLE_SIZE = 0.72;
const LIST_SIZE = 0.2;
const LINE_KEYS = ["c1", "c2"];

export default defineScene({
  id: "release-reel-08-detail-2",
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
    const c1 = useSceneText("c1", "", "embedded");
    const c2 = useSceneText("c2", "", "embedded");
    const lines = [c1, c2];

    const left = -frame.width / 2 + safe.left;
    const right = frame.width / 2 - safe.right;
    const top = frame.height / 2 - safe.top;
    const bottom = -frame.height / 2 + safe.bottom;
    const width = right - left;
    const mark = LIGHT_ROOM ? colors.background : colors.text;

    const perBar = grid?.beatsPerBar ?? 4;
    const span = TO_BAR - FROM_BAR;
    const at = (bar: number, beat = 1) => (grid ? grid.bar(bar, beat) : 0);
    const startMs = at(FROM_BAR);
    const endMs = grid ? at(TO_BAR) : 1;
    const progress = grid ? clamp01((time.localMs - startMs) / (endMs - startMs)) : 0;
    const changeMs = CHANGES.map(([bar, beat]) => at(bar, beat));
    const titleMs = TITLE_AT ? at(TITLE_AT[0], TITLE_AT[1]) : 0;
    const kickerMs = KICKER_AT ? at(KICKER_AT[0], KICKER_AT[1]) : 0;
    let active = 0;
    for (let i = 0; i < changeMs.length; i++) if (time.localMs >= changeMs[i] - 1) active = i;
    const kick =
      1 + 0.03 * pulse(time, changeMs.slice(1), { attackMs: 17, holdMs: 40, releaseMs: 320 });

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
    const listStep = LIST_SIZE * 1.42;
    const listTop = title
      ? railY + 0.34 + (lines.length - 1) * listStep
      : 0.1 + ((lines.length - 1) * listStep) / 2;
    const titleY = title ? Math.min(top - 0.62, listTop + listStep + TITLE_SIZE * 0.72) : 0;

    return (
      <group>
        <AnimatedHeadline
          text={label}
          textKey="label"
          managedTextRole="embedded"
          preset="static"
          face="body"
          opacity={0.7}
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
          opacity={0.7}
          fontSize={0.14}
          anchorX="right"
          textAlign="right"
          position={[right, top - 0.08, 0.01]}
        />
        <group scale={[kick, kick, 1]}>
          {kicker && time.localMs >= kickerMs - 1 ? (
            <AnimatedHeadline
              text={kicker}
              textKey="kicker"
              managedTextRole="embedded"
              preset="static"
              face="body"
              opacity={0.8}
              fontSize={0.17}
              position={[0, titleY + TITLE_SIZE * 0.78, 0.01]}
            />
          ) : null}
          {title ? (
            <AnimatedHeadline
              text={title}
              textKey="title"
              preset={WORD_A_BEAT ? "build" : "stamp"}
              stagger="word"
              staggerMs={WORD_A_BEAT ? Math.round(grid?.beatMs ?? 469) : 0}
              hitAt={titleMs}
              fontSize={TITLE_SIZE}
              fit="width"
              maxWidth={width * 0.9}
              position={[0, titleY, 0.01]}
            />
          ) : null}
          {lines.map((text, i) => (
            <AnimatedHeadline
              key={LINE_KEYS[i]}
              text={text}
              textKey={LINE_KEYS[i]}
              managedTextRole="embedded"
              preset="static"
              face="body"
              opacity={i === active ? 1 : i < active ? 0.55 : 0.3}
              fontSize={LIST_SIZE}
              maxWidth={width * 0.86}
              anchorX={title ? "left" : "center"}
              anchorY="middle"
              textAlign={title ? "left" : "center"}
              position={[title ? left : 0, listTop - i * listStep, 0.01]}
            />
          ))}
        </group>
        {beatsInBar.map((beat) => (
          <group key={`beat-${beat}`} position={[left + 0.05 + (beat - 1) * 0.18, railY, 0.01]}>
            <Pill width={0.1} height={0.1} color={mark} opacity={0.25} />
            <Pill
              width={0.1}
              height={0.1}
              color={mark}
              opacity={pulse(time, beatTimes(beat), { attackMs: 17, holdMs: 90, releaseMs: 320 })}
              position={[0, 0, 0.001]}
            />
          </group>
        ))}
        <Pill
          width={railWidth}
          height={0.024}
          color={mark}
          opacity={0.25}
          position={[railLeft + railWidth / 2, railY, 0.01]}
        />
        <Pill
          width={fill}
          height={0.024}
          color={mark}
          opacity={progress > 0 ? 1 : 0}
          position={[railLeft + fill / 2, railY, 0.011]}
        />
        {barLines.map((bar) => (
          <Pill
            key={`bar-${bar}`}
            width={0.014}
            height={0.12}
            color={mark}
            opacity={0.45}
            position={[xAt(bar), railY, 0.012]}
          />
        ))}
        {changeMs.map((ms) => (
          <Pill
            key={`change-${Math.round(ms)}`}
            width={0.05}
            height={0.05}
            color={mark}
            opacity={time.localMs >= ms - 1 ? 1 : 0.3}
            position={[xAtMs(ms), railY - 0.1, 0.012]}
          />
        ))}
        {HITS.map(([bar, beat]) => (
          <RoundedRect
            key={`hit-${bar}-${beat}`}
            width={0.08}
            height={0.08}
            radius={0.012}
            color={mark}
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
