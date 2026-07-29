import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/**
 * Compare Spike scene 1: the NULL CONTROL. A plain scene with no compare block, proving the
 * comparison machinery leaves ordinary scenes on the byte-identical fast path (this project's
 * baseline moves only if the solo path is perturbed).
 */
export default defineScene({
  id: "compare-null",
  durationMs: 1500,
  Scene() {
    const theme = useTheme();
    const title = useSceneText("title", "Null control");
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        <AnimatedHeadline text={title} textKey="title" from={100} to={700} position={[0, 0.2, 0]} />
      </SceneStage>
    );
  },
});
