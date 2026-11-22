import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

const BAR = 5;
const FLOOR_Y = -1.905;
const TYPE_X = -3.3;
const CHAPTER_Y = 0.78;
const WORD_Y = 0.34;

export default defineScene({
  id: "release-reel-03-word-1",
  durationMs: 1875,
  Scene() {
    const devices = useSceneDevices();
    const grid = useBeatGrid();
    const chapter = useSceneText("chapter", "01 / 03");
    const word = useSceneText("title", "Faster.");
    const at = (beat: number) => (grid ? grid.bar(BAR, beat) : (beat - 1) * 468.75);
    return (
      <SceneStage floorY={FLOOR_Y}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <AnimatedHeadline
          text={chapter}
          textKey="chapter"
          face="body"
          preset="fade"
          hitAt={at(3)}
          fontSize={0.2}
          anchorX="left"
          position={[TYPE_X, CHAPTER_Y, 0]}
        />
        <AnimatedHeadline
          text={word}
          textKey="title"
          preset="slam"
          hitAt={at(1)}
          fontSize={0.42}
          anchorX="left"
          position={[TYPE_X, WORD_Y, 0]}
        />
      </SceneStage>
    );
  },
});
