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

const FROM_BAR = 7;
const TO_BAR = 9;
const HITS: [number, number][] = [];
const CHANGES: [number, number][] = [
  [7, 1],
  [7, 3],
  [8, 1],
  [8, 3],
];

export default defineScene({
  id: "spotlight-04-flow-b",
  durationMs: 3750,
  Scene() {
    const time = useTimeline();
    const { frame, safe } = useFormat();
    const { colors } = useTheme();
    const grid = useBeatGrid();
    const label = useSceneText("label", "", "embedded");
    const bars = useSceneText("bars", "", "embedded");
    const note = useSceneText("note", "", "embedded");
    const c1 = useSceneText("c1", "", "embedded");
    const c2 = useSceneText("c2", "", "embedded");
    const c3 = useSceneText("c3", "", "embedded");
    const c4 = useSceneText("c4", "", "embedded");
    const rows = [c1, c2, c3, c4];

    const left = -frame.width / 2 + safe.left;
    const right = frame.width / 2 - safe.right;
    const top = frame.height / 2 - safe.top;
    const bottom = -frame.height / 2 + safe.bottom;
    const width = right - left;
    const card = liftColour(colors.background, colors.text, 0.1);
    const rail = liftColour(colors.background, colors.text, 0.24);

    const perBar = grid?.beatsPerBar ?? 4;
    const at = (bar: number, beat = 1) => (grid ? grid.bar(bar, beat) : 0);
    const span = TO_BAR - FROM_BAR;
    const startMs = at(FROM_BAR);
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
      Array.from({ length: span }, (_, i) => at(FROM_BAR + i, beat));

    const changeTimes = CHANGES.map(([bar, beat]) => at(bar, beat));
    const current = changeTimes.reduce((found, t, i) => (time.localMs >= t ? i : found), -1);
    const perColumn = Math.ceil(rows.length / 2);
    const columnWidth = width / 2 - 0.08;
    const rowPitch = 0.45;
    const rowTop = -0.34;
    const rowX = (i: number) => left + Math.floor(i / perColumn) * (width / 2 + 0.08);
    const rowY = (i: number) => rowTop - (i % perColumn) * rowPitch;

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
        <AnimatedHeadline
          text={note}
          textKey="note"
          managedTextRole="embedded"
          preset="static"
          face="body"
          defaultColor="muted"
          fontSize={0.3}
          maxWidth={width * 0.8}
          position={[0, 0.72, 0.01]}
        />
        {rows.map((row, i) => (
          <group
            key={`change-${CHANGES[i][0]}-${CHANGES[i][1]}`}
            position={[rowX(i), rowY(i), 0.01]}
          >
            <RoundedRect
              width={columnWidth}
              height={0.37}
              radius={0.07}
              color={colors.background}
              opacity={i === current ? 1 : 0}
              position={[columnWidth / 2, 0, 0]}
            />
            <Pill
              width={0.08}
              height={0.08}
              color={i <= current ? colors.accent : rail}
              position={[0.16, 0, 0.002]}
            />
            <AnimatedHeadline
              text={row}
              textKey={`c${i + 1}`}
              managedTextRole="embedded"
              preset="static"
              face="body"
              defaultColor="text"
              opacity={i === current ? 1 : i < current ? 0.62 : 0.34}
              fontSize={0.165}
              fit="width"
              maxWidth={columnWidth - 0.46}
              anchorX="left"
              textAlign="left"
              position={[0.32, 0, 0.003]}
            />
          </group>
        ))}
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
        {CHANGES.map(([bar, beat], i) => (
          <Pill
            key={`tick-${bar}-${beat}`}
            width={0.07}
            height={0.07}
            color={i <= current ? colors.accent : rail}
            position={[xAt(bar, beat), railY, 0.013]}
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
              1 + 0.9 * pulse(time, at(bar, beat), { attackMs: 17, holdMs: 120, releaseMs: 520 })
            }
            position={[xAt(bar, beat), railY + 0.15, 0.014]}
          />
        ))}
      </group>
    );
  },
});
