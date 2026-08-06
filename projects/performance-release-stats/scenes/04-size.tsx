import {
  AnimatedCounter,
  AnimatedHeadline,
  defineScene,
  SceneStage,
  useFormat,
  useSceneText,
} from "@kookaburra/toolkit";

/** Scene 4: the download-size stat. Label, unit and the context note come from the sidecar; the counter is the one accent. */
export default defineScene({
  id: "performance-release-stats-04-size",
  durationMs: 2800,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Download size");
    const unit = useSceneText("unit", "MB");
    const note = useSceneText("note", "Down from 142 MB in 2.3");
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
          position={[0, portrait ? 0.66 : 0.8, 0]}
          fontSize={portrait ? 0.18 : 0.24}
          defaultColor="muted"
        />
        <AnimatedCounter
          from={142}
          to={86}
          durationMs={1400}
          format={(n) => `${Math.round(n)} ${unit}`}
          position={[0, portrait ? -0.1 : -0.06, 0]}
          fontSize={portrait ? 0.5 : 0.9}
        />
        {note ? (
          <AnimatedHeadline
            text={note}
            textKey="note"
            face="body"
            defaultColor="muted"
            from={1400}
            to={2000}
            position={[0, portrait ? -0.78 : -0.86, 0]}
            fontSize={portrait ? 0.13 : 0.17}
            textAlign="center"
            maxWidth={format.frame.width - format.safe.left - format.safe.right}
          />
        ) : null}
      </SceneStage>
    );
  },
});
