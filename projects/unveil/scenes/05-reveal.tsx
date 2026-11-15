import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useBeatGrid,
  useFormat,
  useSceneDevices,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

// The question hangs on the camera's line to the phone and is gone just before the fly reaches it.
const QUESTION_AT: [number, number, number] = [-0.663, -0.889, 8.974];
const QUESTION_FACING: [number, number, number, "YXZ"] = [0.1053, 0.1326, 0, "YXZ"];
const QUESTION_FRAME_HEIGHT = 1.33;

export default defineScene({
  id: "unveil-05-reveal",
  durationMs: 11250,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const { aspect } = useFormat();
    const { localMs } = useTimeline();
    const question = useSceneText("question", "Your week, planned for you.");
    const name = useSceneText("title", "Meet Fairywren.");
    const beatMs = Math.round(grid?.beatMs ?? 469);
    const passAt = (grid?.at(8, 4) ?? 3281) + 230;
    return (
      <SceneStage floorY={-1.905}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <group position={QUESTION_AT} rotation={QUESTION_FACING} visible={localMs < passAt}>
          <AnimatedHeadline
            text={question}
            textKey="question"
            stagger="word"
            staggerMs={beatMs}
            hitAt={0}
            fontSize={0.3}
            fit="width"
            maxWidth={QUESTION_FRAME_HEIGHT * aspect * 0.78}
          />
        </group>
        <AnimatedHeadline
          text={name}
          textKey="title"
          hitAt={grid?.at(11) ?? 7500}
          fontSize={0.56}
          position={[1.4, -0.1, 1.2]}
        />
      </SceneStage>
    );
  },
});
