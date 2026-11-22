import {
  AnimatedCounter,
  AnimatedHeadline,
  Device,
  defineScene,
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
const FIGURE_AT: [number, number, number] = [-2.95, -0.2, -4.2];
const UNIT_GAP = 0.74;
const CAPTION_AT: [number, number, number] = [-2.95, -0.98, -4.2];
const CAPTION_LEAD_MS = 700;

export default defineScene({
  id: "spotlight-07-proof",
  durationMs: 5625,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { localMs } = useTimeline();
    const { motion } = useTheme();
    const figure = useSceneText("figure", "0", "embedded");
    const unit = useSceneText("unit", "", "embedded");
    const caption = useSceneText("caption", "");
    const card = useProjectShared<[number, number, number, number]>(
      "proof.rect",
      [0.05, 0.2, 0.95, 0.35],
    );
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const countFrom = grid?.at(12, 2) ?? 469;
    const countTo = grid?.at(13, 1) ?? 1875;
    const liftAt = (grid?.at(13, 3) ?? 2812) - 420;
    const captionAt = grid?.at(14, 1) ?? 3750;
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
        <AnimatedCounter
          from={0}
          to={Number(figure) || 0}
          startMs={countFrom}
          durationMs={countTo - countFrom}
          ticks="beats"
          textKey="figure"
          fontSize={1}
          anchorX="left"
          position={FIGURE_AT}
        />
        <AnimatedHeadline
          text={unit}
          textKey="unit"
          managedTextRole="embedded"
          preset="static"
          fontSize={1}
          anchorX="left"
          textAlign="left"
          position={[FIGURE_AT[0] + UNIT_GAP, FIGURE_AT[1], FIGURE_AT[2]]}
        />
        <group visible={localMs >= captionAt - CAPTION_LEAD_MS}>
          <AnimatedHeadline
            text={caption}
            textKey="caption"
            hitAt={captionAt}
            to={motion.durations.base}
            fontSize={0.22}
            anchorX="left"
            textAlign="left"
            position={CAPTION_AT}
          />
        </group>
      </SceneStage>
    );
  },
});
