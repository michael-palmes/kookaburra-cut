import {
  AnimatedHeadline,
  defineScene,
  RoundedRect,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -1.905;
const BAND_WIDTH = 2.4;
const BAND_HEIGHT = 7;
const BAND_TRAVEL = 11;

export default defineScene({
  id: "release-reel-02-whats-new",
  durationMs: 4150,
  Scene() {
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const theme = useTheme();
    const line = useSceneText("title", "What’s new.");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - 3) * 4 + beat - 1) * 468.75;
    const beatMs = at(3, 2) - at(3);
    const bands = [
      theme.chartColors?.[0] ?? theme.colors.accent,
      theme.colors.background,
      theme.chartColors?.[2] ?? theme.colors.muted,
    ];
    return (
      <SceneStage floorY={FLOOR_Y}>
        {bands.map((colour, i) => {
          const from = at(4) + (i * beatMs) / 4;
          const t = ramp(localMs, from, from + 1.4 * beatMs, "inOutCubic");
          return (
            <RoundedRect
              key={colour}
              width={BAND_WIDTH}
              height={BAND_HEIGHT}
              radius={0}
              color={colour}
              position={[
                -BAND_TRAVEL + 2 * BAND_TRAVEL * t,
                FLOOR_Y + BAND_HEIGHT / 2,
                -0.6 - i * 0.05,
              ]}
            />
          );
        })}
        <AnimatedHeadline
          text={line}
          textKey="title"
          preset="stamp"
          stagger="word"
          staggerMs={beatMs}
          hitAt={at(3)}
          fontSize={0.62}
          position={[0, 0.1, 0]}
        />
      </SceneStage>
    );
  },
});
