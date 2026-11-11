import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "unveil-06-name",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const name = useSceneText("title", "Meet Fairywren.");
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <AnimatedHeadline
          text={name}
          textKey="title"
          hitAt={0}
          fontSize={0.56}
          position={[1.4, 0, 1.2]}
        />
      </SceneStage>
    );
  },
});
