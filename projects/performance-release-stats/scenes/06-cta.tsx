import {
  AnimatedHeadline,
  BrandLockup,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Scene 6: the end card. The source line holds under the lockup; swap `assets/app-icon.png` for the real icon. */
export default defineScene({
  id: "performance-release-stats-06-cta",
  durationMs: 3800,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title", "Kestrel");
    const subtitle = useSceneText("subtitle", "Update now");
    const source = useSceneText("source", "Measured on iPhone 15, n=200 runs");
    return (
      <SceneStage>
        <BrandLockup title={title} subtitle={subtitle} />
        <AnimatedHeadline
          text={source}
          textKey="source"
          face="body"
          defaultColor="muted"
          from={1200}
          to={1800}
          position={[0, portrait ? -0.95 : -1.2, 0]}
          fontSize={0.17}
          textAlign="center"
          maxWidth={format.frame.width - format.safe.left - format.safe.right}
        />
      </SceneStage>
    );
  },
});
