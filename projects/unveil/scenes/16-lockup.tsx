import {
  AnimatedGroup,
  AnimatedHeadline,
  clamp01,
  defineScene,
  ease,
  ImageCard,
  SceneStage,
  useBeatGrid,
  useFormat,
  useSceneText,
  useTimeline,
} from "@kookaburra/toolkit";

const ICON_Y = 0.72;
const ICON = 1.6;
const NAME_Y = -0.64;
const CALL_Y = -1.27;
const LAND_MS = 520;

export default defineScene({
  id: "unveil-16-lockup",
  durationMs: 3750,
  Scene() {
    const grid = useBeatGrid();
    const { frame, safe } = useFormat();
    const { localMs } = useTimeline();
    const name = useSceneText("name", "Fairywren");
    const call = useSceneText("title", "Available today.");
    const glintAt = grid?.at(31, 3) ?? 937;
    const callAt = grid?.at(32) ?? 1875;
    const land = ease("outCubic", clamp01(localMs / LAND_MS));
    const icon = Math.min(ICON, frame.width * 0.5);
    const width = frame.width - safe.left - safe.right;
    return (
      <SceneStage floorY={-1.905}>
        <group position={[0, ICON_Y + 0.3 * (1 - land), 0]} scale={1.08 - 0.08 * land}>
          <ImageCard src="assets/app-icon.png" width={icon} from={0} to={50} />
          <AnimatedGroup
            preset="fade-scale"
            startScale={1}
            shine
            from={glintAt}
            to={glintAt + 700}
            ease="inOutSine"
            extent={[icon * 1.2, icon * 1.2]}
            position={[0, 0, 0.002]}
          >
            <ImageCard src="assets/app-icon.png" width={icon} />
          </AnimatedGroup>
        </group>
        <AnimatedHeadline
          text={name}
          textKey="name"
          hitAt={300}
          fontSize={0.72}
          fit="width"
          maxWidth={width}
          position={[0, NAME_Y, 0]}
        />
        <AnimatedHeadline
          text={call}
          textKey="title"
          hitAt={callAt}
          fontSize={0.28}
          fit="width"
          maxWidth={width}
          position={[0, CALL_Y, 0]}
        />
      </SceneStage>
    );
  },
});
