import {
  AnimatedHeadline,
  Device,
  defineScene,
  ramp,
  SceneStage,
  Slab,
  useBeatGrid,
  useSceneDevices,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FIRST_BAR = 21;
const FLOOR_Y = -1.905;
const PANEL_WIDTH = 2.3;
const PANEL_HEIGHT = 4.3;
const PANEL_DEPTH = 0.2;
const PANEL_Z = -0.55;
const SPACING = 2.75;
const LABEL_Y = 1.72;
const RISE_MS = 340;
const DROP = 0.7;

const LANDS: [number, number][] = [
  [21, 1],
  [21, 3],
  [22, 1],
];
const KEYS = ["c1", "c2", "c3"];

export default defineScene({
  id: "release-reel-13-all-three",
  durationMs: 3750,
  Scene() {
    const devices = useSceneDevices();
    const first = devices.find((d) => d.id === "first") ?? devices[0];
    const second = devices.find((d) => d.id === "second") ?? devices[1];
    const third = devices.find((d) => d.id === "third") ?? devices[2];
    const phones = [first, second, third];
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const theme = useTheme();
    const labels = [
      useSceneText("c1", "Faster.", "embedded"),
      useSceneText("c2", "Smarter.", "embedded"),
      useSceneText("c3", "Together.", "embedded"),
    ];
    const colours = [
      theme.chartColors?.[0] ?? theme.colors.accent,
      theme.colors.background,
      theme.chartColors?.[2] ?? theme.colors.muted,
    ];
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - FIRST_BAR) * 4 + beat - 1) * 468.75;
    return (
      <SceneStage floorY={FLOOR_Y}>
        {LANDS.map(([bar, beat], i) => {
          const from = at(bar, beat);
          const up = ramp(localMs, from, from + RISE_MS, "outBack");
          const shown = localMs >= from;
          const settle = ramp(localMs, from + 60, from + 60 + RISE_MS, "outCubic");
          const phone = phones[i];
          const x = (i - 1) * SPACING;
          return (
            <group key={KEYS[i]} visible={shown}>
              <group position={[x, FLOOR_Y, PANEL_Z]} rotation={[(up - 1) * (Math.PI / 2), 0, 0]}>
                <Slab
                  width={PANEL_WIDTH}
                  height={PANEL_HEIGHT}
                  depth={PANEL_DEPTH}
                  radius={0.09}
                  bevel={0.02}
                  color={colours[i]}
                  finish={{ roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.3 }}
                  shadow
                  position={[0, PANEL_HEIGHT / 2, 0]}
                >
                  <AnimatedHeadline
                    text={labels[i]}
                    textKey={KEYS[i]}
                    managedTextRole="embedded"
                    preset="fade"
                    hitAt={from + RISE_MS}
                    fontSize={0.3}
                    position={[0, LABEL_Y - PANEL_HEIGHT / 2 - FLOOR_Y, 0]}
                  />
                </Slab>
              </group>
              {phone ? (
                <group position={[0, (1 - settle) * DROP, 0]}>
                  <Device {...phone} />
                </group>
              ) : null}
            </group>
          );
        })}
      </SceneStage>
    );
  },
});
