import {
  AnimatedHeadline,
  defineScene,
  RoundedRect,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneDoc,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FLOOR_Y = -1.905;
const BAND_WIDTH = 1.7;
const BAND_HEIGHT = 7;
const BAND_TRAVEL = 11;

export default defineScene({
  id: "release-reel-02-whats-new",
  durationMs: 3752,
  Scene() {
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const theme = useTheme();
    const line = useSceneText("title", "What’s new.");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - 3) * 4 + beat - 1) * 468.75;
    const beatMs = at(3, 2) - at(3);
    const style = useSceneDoc()?.textStyle;
    const pinned = (key: string, fallback: string) => {
      const value = style?.[key];
      return typeof value === "string" ? value : fallback;
    };
    const bands = [
      pinned("band1Color", theme.chartColors?.[0] ?? theme.colors.accent),
      pinned("band2Color", theme.colors.background),
      pinned("band3Color", theme.chartColors?.[2] ?? theme.colors.muted),
    ];
    return (
      <SceneStage floorY={FLOOR_Y}>
        {bands.map((colour, i) => {
          const t = ramp(localMs, at(4), at(4) + 1.8 * beatMs, "inOutCubic");
          return (
            <RoundedRect
              key={colour}
              width={BAND_WIDTH}
              height={BAND_HEIGHT}
              radius={0}
              color={colour}
              position={[
                -BAND_TRAVEL + 2 * BAND_TRAVEL * t + (1 - i) * BAND_WIDTH,
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
          hitAt={at(3, 3)}
          fontSize={0.62}
          position={[0, 0.1, 0]}
        />
      </SceneStage>
    );
  },
});
