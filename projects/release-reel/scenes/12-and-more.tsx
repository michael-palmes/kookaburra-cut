import {
  AnimatedHeadline,
  Device,
  defineScene,
  ImageCard,
  ramp,
  SceneStage,
  Slab,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const FIRST_BAR = 17;
const FLOOR_Y = -1.905;
const CHIP_HEIGHT = 0.52;
const LABEL_SIZE = 0.2;
const ICON_SIZE = 0.3;
const PAD = 0.22;
const GAP = 0.12;
const TITLE_X = -3.9;
const TITLE_Y = 1.3;

const CHIPS: {
  key: string;
  bar: number;
  beat: number;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}[] = [
  {
    key: "c1",
    bar: 18,
    beat: 1,
    position: [-2.9, 0.42, -0.9],
    rotation: [0.12, 0.3, -0.1],
    scale: 1.1,
  },
  {
    key: "c2",
    bar: 18,
    beat: 2,
    position: [3.0, 0.8, -0.9],
    rotation: [0.12, -0.3, 0.12],
    scale: 1.1,
  },
  {
    key: "c3",
    bar: 18,
    beat: 3,
    position: [-2.75, -0.42, 0.4],
    rotation: [0.06, 0.22, -0.06],
    scale: 1.3,
  },
  {
    key: "c4",
    bar: 18,
    beat: 4,
    position: [2.85, -0.3, 0.4],
    rotation: [0.06, -0.22, 0.04],
    scale: 1.3,
  },
  {
    key: "c5",
    bar: 19,
    beat: 1,
    position: [-2.45, -1.25, 2.2],
    rotation: [-0.14, 0.18, 0.1],
    scale: 1.4,
  },
  {
    key: "c6",
    bar: 19,
    beat: 3,
    position: [2.55, -1.2, 2.2],
    rotation: [-0.14, -0.18, -0.12],
    scale: 1.4,
  },
];

export default defineScene({
  id: "release-reel-12-and-more",
  durationMs: 7900,
  Scene() {
    const devices = useSceneDevices();
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const title = useSceneText("title", "And more.");
    const labels = [
      useSceneText("c1", "Widgets", "embedded"),
      useSceneText("c2", "Dark mode", "embedded"),
      useSceneText("c3", "Faster sync", "embedded"),
      useSceneText("c4", "New icons", "embedded"),
      useSceneText("c5", "Shortcuts", "embedded"),
      useSceneText("c6", "Offline", "embedded"),
    ];
    const icons = [
      useSceneText("c1Icon", "", "embedded"),
      useSceneText("c2Icon", "", "embedded"),
      useSceneText("c3Icon", "", "embedded"),
      useSceneText("c4Icon", "", "embedded"),
      useSceneText("c5Icon", "", "embedded"),
      useSceneText("c6Icon", "", "embedded"),
    ];
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - FIRST_BAR) * 4 + beat - 1) * 468.75;
    const settle = 1 + 0.06 * Math.sin(Math.PI * ramp(localMs, at(20), at(20) + 260, "linear"));
    return (
      <SceneStage floorY={FLOOR_Y}>
        {devices.map((d) => (
          <Device key={d.id} {...d} />
        ))}
        <AnimatedHeadline
          text={title}
          textKey="title"
          preset="slam"
          hitAt={at(17)}
          fontSize={0.52}
          anchorX="left"
          position={[TITLE_X, TITLE_Y, 0]}
        />
        {CHIPS.map((chip, i) => {
          const label = labels[i];
          const icon = icons[i];
          const iconWidth = icon ? ICON_SIZE + GAP : 0;
          const side = chip.position[0] < 0 ? -1 : 1;
          const width = 2 * PAD + iconWidth + label.length * LABEL_SIZE * 0.56;
          const left = -width / 2 + PAD;
          const from = at(chip.bar, chip.beat);
          const pop = ramp(localMs, from, from + 300, "outBack");
          const off = ramp(localMs, at(20, 3) + i * 30, at(20, 3) + i * 30 + 420, "inCubic");
          const bob = 0.03 * Math.sin(localMs / 700 + i * 1.7);
          return (
            <Slab
              key={chip.key}
              width={width}
              height={CHIP_HEIGHT}
              depth={0.42}
              bevel={0.2}
              color="muted"
              finish={{ roughness: 0.22, clearcoatRoughness: 0.12 }}
              shadow
              position={[
                chip.position[0] + side * off * 7,
                chip.position[1] + bob + (1 - pop) * -0.25,
                chip.position[2],
              ]}
              rotation={[chip.rotation[0], chip.rotation[1], chip.rotation[2] + side * off * 0.5]}
              scale={Math.max(chip.scale * pop * settle, 0.0001)}
            >
              {icon ? (
                <ImageCard src={icon} width={ICON_SIZE} position={[left + ICON_SIZE / 2, 0, 0]} />
              ) : null}
              <AnimatedHeadline
                text={label}
                textKey={chip.key}
                managedTextRole="embedded"
                preset="static"
                fontSize={LABEL_SIZE}
                anchorX="left"
                anchorY="middle"
                textAlign="left"
                position={[left + iconWidth, 0, 0]}
              />
            </Slab>
          );
        })}
      </SceneStage>
    );
  },
});
