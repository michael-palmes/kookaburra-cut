import {
  AnimatedHeadline,
  Device,
  DustBurst,
  defineScene,
  ImageCard,
  Ripple,
  ramp,
  SceneStage,
  Slab,
  useBeatGrid,
  useDeviceScreenPoint,
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
const TITLE_X = -3.75;
const TITLE_Y = 1.3;

const FLIGHT_MS = 330;
const FLIGHT_GAP_MS = 85;
const NO_DEVICE = { model: "" };

const CHIPS: {
  key: string;
  bar: number;
  beat: number;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  screen: [number, number];
}[] = [
  {
    key: "c1",
    bar: 18,
    beat: 1,
    position: [-2.7, 0.42, -0.9],
    rotation: [0.12, 0.3, -0.1],
    scale: 1.1,
    screen: [-0.26, 0.5],
  },
  {
    key: "c2",
    bar: 18,
    beat: 2,
    position: [2.8, 0.8, -0.9],
    rotation: [0.12, -0.3, 0.12],
    scale: 1.1,
    screen: [0.26, 0.56],
  },
  {
    key: "c3",
    bar: 18,
    beat: 3,
    position: [-2.3, -0.42, 0.4],
    rotation: [0.06, 0.22, -0.06],
    scale: 1.15,
    screen: [-0.26, 0.05],
  },
  {
    key: "c4",
    bar: 18,
    beat: 4,
    position: [2.35, -0.3, 0.4],
    rotation: [0.06, -0.22, 0.04],
    scale: 1.15,
    screen: [0.26, 0.12],
  },
  {
    key: "c5",
    bar: 19,
    beat: 1,
    position: [-2.23, -1.22, 1.2],
    rotation: [-0.14, 0.18, 0.1],
    scale: 1.15,
    screen: [-0.24, -0.5],
  },
  {
    key: "c6",
    bar: 19,
    beat: 3,
    position: [2.25, -1.18, 1.2],
    rotation: [-0.14, -0.18, -0.12],
    scale: 1.15,
    screen: [0.24, -0.56],
  },
];

function turn(v: [number, number, number], r: [number, number, number]): [number, number, number] {
  const [cx, cy, cz] = [Math.cos(r[0]), Math.cos(r[1]), Math.cos(r[2])];
  const [sx, sy, sz] = [Math.sin(r[0]), Math.sin(r[1]), Math.sin(r[2])];
  const x1 = v[0] * cz - v[1] * sz;
  const y1 = v[0] * sz + v[1] * cz;
  const x2 = x1 * cy + v[2] * sy;
  const z2 = -x1 * sy + v[2] * cy;
  return [x2, y1 * cx - z2 * sx, y1 * sx + z2 * cx];
}

export default defineScene({
  id: "release-reel-12-and-more",
  durationMs: 7900,
  Scene() {
    const devices = useSceneDevices();
    const hero = devices.find((d) => d.id === "hero") ?? devices[0];
    const screen = useDeviceScreenPoint(hero ?? NO_DEVICE, 0.5, 0.5, { lift: 0.06 });
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
          const launch = at(20, 3) + i * FLIGHT_GAP_MS;
          const fly = ramp(localMs, launch, launch + FLIGHT_MS, "inCubic");
          const bob = 0.03 * Math.sin(localMs / 700 + i * 1.7) * (1 - fly);
          const spot = turn(
            [chip.screen[0] * screen.scale, chip.screen[1] * screen.scale, 0],
            screen.rotation,
          );
          const target: [number, number, number] = hero
            ? [
                screen.position[0] + spot[0],
                screen.position[1] + spot[1],
                screen.position[2] + spot[2],
              ]
            : [chip.position[0] + side * 7, chip.position[1], chip.position[2]];
          const home: [number, number, number] = [
            chip.position[0],
            chip.position[1] + bob + (1 - pop) * -0.25,
            chip.position[2],
          ];
          const shrink = hero
            ? (1 - 0.86 * fly) *
              (1 - ramp(localMs, launch + FLIGHT_MS * 0.86, launch + FLIGHT_MS, "linear"))
            : 1;
          return (
            <group key={chip.key}>
              <Slab
                width={width}
                height={CHIP_HEIGHT}
                depth={0.5}
                bevel={0.42}
                color="muted"
                finish={{ roughness: 0.12, clearcoatRoughness: 0.04, envIntensity: 1.7 }}
                shadow
                position={[
                  home[0] + (target[0] - home[0]) * fly,
                  home[1] + (target[1] - home[1]) * fly,
                  home[2] + (target[2] - home[2]) * fly + 0.6 * Math.sin(Math.PI * fly),
                ]}
                rotation={[
                  chip.rotation[0] + (screen.rotation[0] - chip.rotation[0]) * fly,
                  chip.rotation[1] + (screen.rotation[1] - chip.rotation[1]) * fly,
                  chip.rotation[2] + (screen.rotation[2] - chip.rotation[2]) * fly,
                ]}
                scale={Math.max(chip.scale * pop * settle * shrink, 0.0001)}
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
              {hero ? (
                <group position={target} rotation={screen.rotation}>
                  <Ripple
                    at={launch + FLIGHT_MS - 40}
                    radius={0.52}
                    durationMs={650}
                    position={[0, 0, 0.02]}
                  />
                  <group rotation={[Math.PI / 2, 0, 0]}>
                    <DustBurst
                      at={launch + FLIGHT_MS - 40}
                      footprint={[0.02, 0.02]}
                      count={10}
                      seed={i + 3}
                      reach={0.3}
                      lift={0.05}
                      size={0.4}
                      flatten={1}
                      durationMs={420}
                      opacity={0.16}
                      tone="accent"
                    />
                  </group>
                </group>
              ) : null}
            </group>
          );
        })}
      </SceneStage>
    );
  },
});
