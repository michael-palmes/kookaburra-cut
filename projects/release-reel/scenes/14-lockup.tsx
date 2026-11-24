import {
  AnimatedHeadline,
  defineScene,
  IconTile,
  measureText,
  Pill,
  ramp,
  SceneStage,
  useBeatGrid,
  useSceneDoc,
  useSceneText,
  useTheme,
  useTimeline,
} from "@kookaburra/toolkit";

const FIRST_BAR = 23;
const FLOOR_Y = -1.905;
const TILE = 1.6;
const TILE_X = -2.15;
const TEXT_X = -0.95;
const NAME_SIZE = 0.62;
const NAME_Y = FLOOR_Y + TILE / 2 + 0.2;
const LINE_SIZE = 0.44;
const LINE_Y = NAME_Y - 0.62;
const PILL_HEIGHT = 0.36;
const VERSION_SIZE = 0.2;

export default defineScene({
  id: "release-reel-14-lockup",
  durationMs: 3981,
  Scene() {
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const theme = useTheme();
    const badge = useSceneDoc()?.textStyle?.versionColor;
    const name = useSceneText("kicker", "Fairywren");
    const version = useSceneText("version", "2.4", "embedded");
    const line = useSceneText("title", "Update today.");
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - FIRST_BAR) * 4 + beat - 1) * 468.75;
    const nameWidth =
      measureText(name, { font: theme.typography.headline, fontSize: NAME_SIZE })?.width ??
      name.length * 0.5 * NAME_SIZE;
    const pillWidth = 0.42 + version.length * VERSION_SIZE * 0.62;
    const pillX = TEXT_X + nameWidth + 0.22 + pillWidth / 2;
    const pop = ramp(localMs, at(23, 3) + 120, at(23, 3) + 380, "outBack");
    const kick = 1 + 0.09 * Math.sin(Math.PI * ramp(localMs, at(24), at(24) + 300, "linear"));
    return (
      <SceneStage floorY={FLOOR_Y}>
        <IconTile
          src="assets/app-icon.png"
          size={TILE}
          depth={TILE * 0.28}
          bevel={0.05}
          finish={{ clearcoatRoughness: 0.3 }}
          shadow
          position={[TILE_X, FLOOR_Y + (TILE * kick) / 2, 0]}
          rotation={[0, 0.16, 0]}
        />
        <AnimatedHeadline
          text={name}
          textKey="kicker"
          preset="stamp"
          hitAt={at(23, 3)}
          fontSize={NAME_SIZE}
          anchorX="left"
          anchorY="middle"
          position={[TEXT_X, NAME_Y, 0]}
        />
        <group position={[pillX, NAME_Y + 0.02, 0]} scale={Math.max(pop, 0.0001)}>
          <Pill
            width={pillWidth}
            height={PILL_HEIGHT}
            color={theme.colors.background}
            fillOpacity={0}
            strokeWidth={0.035}
            strokeColor={typeof badge === "string" ? badge : theme.colors.text}
          />
          <AnimatedHeadline
            text={version}
            textKey="version"
            managedTextRole="embedded"
            preset="static"
            face="body"
            fontSize={VERSION_SIZE}
            anchorY="middle"
            position={[0, 0, 0.005]}
          />
        </group>
        <AnimatedHeadline
          text={line}
          textKey="title"
          preset="stamp"
          hitAt={at(24)}
          fontSize={LINE_SIZE}
          anchorX="left"
          anchorY="middle"
          position={[TEXT_X, LINE_Y, 0]}
        />
      </SceneStage>
    );
  },
});
