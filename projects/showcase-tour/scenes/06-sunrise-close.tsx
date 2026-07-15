import {
  AnimatedHeadline,
  defineScene,
  ImageCard,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Showcase tour scene 6 — Sunrise: the pastel gradient close with the app icon and a
 * staggered call-to-action.
 */
export default defineScene({
  id: "tour-sunrise-close",
  durationMs: 2600,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const cta = useSceneText("cta", "Start creating");
    const sub = useSceneText("sub", "Pick a theme, press export");
    return (
      <SceneStage>
        <ImageCard
          src="assets/app-icon.png"
          from={150}
          to={700}
          position={[0, portrait ? 1.0 : 0.8, 0]}
          width={portrait ? 0.9 : 1.0}
        />
        <AnimatedHeadline
          text={cta}
          textKey="cta"
          from={400}
          to={1100}
          position={[0, portrait ? -0.3 : -0.4, 0]}
          fontSize={portrait ? 0.26 : 0.4}
        />
        <AnimatedHeadline
          text={sub}
          textKey="sub"
          from={800}
          to={1500}
          face="body"
          defaultColor="muted"
          position={[0, portrait ? -0.85 : -0.95, 0]}
          fontSize={portrait ? 0.13 : 0.18}
        />
      </SceneStage>
    );
  },
});
