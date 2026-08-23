import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

/** Scene 2: the hero device. Swap the recording, the camera keys and the lighting in the sidecar. */
export default defineScene({
  id: "subscriber-feature-drop-02-feature-hero",
  durationMs: 4000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    const subtitle = useSceneText("subtitle");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={900}
            position={[0, 1.35, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        {subtitle ? (
          <AnimatedHeadline
            text={subtitle}
            textKey="subtitle"
            face="body"
            defaultColor="muted"
            from={550}
            to={1250}
            position={[0, portrait ? 1.12 : 0.96, 0]}
            fontSize={(portrait ? 0.23 : 0.42) / theme.typography.scale ** 4}
          />
        ) : null}
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
            }}
          />
        ))}
      </SceneStage>
    );
  },
});
