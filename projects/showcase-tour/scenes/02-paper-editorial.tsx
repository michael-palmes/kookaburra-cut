import {
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Showcase tour scene 2 — Paper: the serif mask-reveal (theme default) over the warm cream
 * floor with its long low-key shadows.
 */
export default defineScene({
  id: "tour-paper-editorial",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title", "Set in Playfair");
    const body = useSceneText("body", "Long shadows on warm paper");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={title}
          textKey="title"
          from={250}
          to={1100}
          position={[0, portrait ? 0.5 : 0.3, 0]}
          fontSize={portrait ? 0.3 : 0.52}
        />
        <AnimatedHeadline
          text={body}
          textKey="body"
          from={900}
          to={1700}
          face="body"
          defaultColor="muted"
          position={[0, portrait ? -0.32 : -0.5, 0]}
          fontSize={portrait ? 0.13 : 0.19}
        />
      </SceneStage>
    );
  },
});
