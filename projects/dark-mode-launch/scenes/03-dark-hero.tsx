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

/** The dark hero: the claim over the new home screen, with the sidecar's push-in. */
export default defineScene({
  id: "dark-mode-launch-03-dark-hero",
  durationMs: 3600,
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
            position={[0, portrait ? 1.62 : 1.4, 0]}
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
            position={[0, portrait ? 1.4 : 1.02, 0]}
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
