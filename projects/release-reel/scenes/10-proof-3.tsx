import {
  AnimatedHeadline,
  Device,
  defineScene,
  ramp,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const FIRST_BAR = 14;
const FLOOR_Y = -1.905;
const CARD: [number, number, number, number] = [0.04, 0.172, 0.96, 0.322];
const TYPE_X = -3.3;
const CHAPTER_Y = 0.78;
const KICKER_Y = 0.34;
const LINE_TOP = 0.0;
const LINE_WIDTH = 4.4;
const LIFT = 0.07;

export default defineScene({
  id: "release-reel-10-proof-3",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const chapter = useSceneText("chapter", "03 / 03");
    const kicker = useSceneText("kicker", "Together.");
    const line = useSceneText("title", "Share a list with one tap.");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - FIRST_BAR) * 4 + beat - 1) * 468.75;
    const lineAt = at(14, 3);
    const wordMs = (at(14, 4) - lineAt) / 4;
    const liftAt = at(15, 3);
    const typeOutAt = liftAt + 120;
    const lift = LIFT * ramp(localMs, liftAt, liftAt + 700, "outCubic");
    const lineOpacity = 1 - ramp(localMs, typeOutAt, typeOutAt + 280, "outCubic");
    return (
      <SceneStage floorY={FLOOR_Y}>
        {hero ? (
          <Device {...hero}>
            <ScreenRegion
              rect={CARD}
              at={liftAt}
              durationMs={700}
              lift={lift}
              scale={1.03}
              cornerRadius={0.075}
              shadow={0.5}
            />
          </Device>
        ) : null}
        {devices.map((d) => (d === hero ? null : <Device key={d.id} {...d} />))}
        <AnimatedHeadline
          text={chapter}
          textKey="chapter"
          face="body"
          preset="fade"
          hitAt={0}
          fontSize={0.2}
          outAt={typeOutAt}
          outPreset="fade"
          outDurationMs={280}
          anchorX="left"
          position={[TYPE_X, CHAPTER_Y, 0]}
        />
        <AnimatedHeadline
          text={kicker}
          textKey="kicker"
          preset="fade"
          hitAt={0}
          fontSize={0.42}
          outAt={typeOutAt}
          outPreset="fade"
          outDurationMs={280}
          anchorX="left"
          position={[TYPE_X, KICKER_Y, 0]}
        />
        <AnimatedHeadline
          text={line}
          textKey="title"
          preset="dolly"
          stagger="word"
          staggerMs={wordMs}
          to={wordMs * 4}
          hitAt={lineAt}
          opacity={lineOpacity}
          fontSize={0.5}
          lineHeight={1.02}
          anchorX="left"
          anchorY="top"
          textAlign="left"
          maxWidth={LINE_WIDTH}
          position={[TYPE_X, LINE_TOP, 0]}
        />
      </SceneStage>
    );
  },
});
