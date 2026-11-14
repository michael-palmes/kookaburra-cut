import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-05-reveal",
  durationMs: 7500,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const name = useSceneText("title", "Meet Fairywren.");
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <AnimatedHeadline
          text={name}
          textKey="title"
          hitAt={grid?.at(11) ?? 3750}
          fontSize={0.56}
          position={[1.4, -0.1, 1.2]}
        />
      </SceneStage>
    );
  },
});
