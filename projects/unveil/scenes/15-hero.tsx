import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useBeatGrid,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

const SLOGAN_AT: [number, number, number] = [-2.05, -1.72, 5.0];
const SLOGAN_SIZE = 0.34;

export default defineScene({
  id: "unveil-15-hero",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { aspect } = useFormat();
    const slogan = useSceneText("slogan", "Your week, sorted.");
    const hitAt = grid?.at(30) ?? 1875;
    const outAt = grid?.at(30, 4) ?? 3281;
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <group position={SLOGAN_AT} scale={Math.min(1, aspect / 1.2)}>
          <AnimatedHeadline
            text={slogan}
            textKey="slogan"
            hitAt={hitAt}
            outAt={outAt}
            outDurationMs={300}
            fontSize={SLOGAN_SIZE}
          />
        </group>
      </SceneStage>
    );
  },
});
