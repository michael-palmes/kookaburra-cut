import {
  AnimatedGroup,
  AnimatedHeadline,
  Device,
  defineScene,
  ImageCard,
  SceneStage,
  useBeatGrid,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

const LOCKUP_AT: [number, number, number] = [-2.05, -1.72, 5.0];
const ICON = 0.5;
const GAP = 0.16;
const NAME_SIZE = 0.4;

export default defineScene({
  id: "unveil-17-hero",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { aspect } = useFormat();
    const name = useSceneText("name", "Fairywren");
    const riseAt = grid?.at(30) ?? 1875;
    const nameWidth = NAME_SIZE * 0.56 * name.length;
    const left = -(ICON + GAP + nameWidth) / 2;
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <group position={LOCKUP_AT} scale={Math.min(1, aspect / 1.2)}>
          <AnimatedGroup preset="fade-up" from={riseAt} to={riseAt + 700} ease="outCubic" em={0.5}>
            <ImageCard
              src="assets/fairywren-icon.png"
              width={ICON}
              position={[left + ICON / 2, 0, 0]}
            />
            <AnimatedHeadline
              text={name}
              textKey="name"
              fontSize={NAME_SIZE}
              anchorX="left"
              position={[left + ICON + GAP, -0.02, 0]}
            />
          </AnimatedGroup>
        </group>
      </SceneStage>
    );
  },
});
