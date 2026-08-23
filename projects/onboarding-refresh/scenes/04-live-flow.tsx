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

/** Onboarding Refresh 4: the recorded first run on a handset, under one slow push. */
export default defineScene({
  id: "onboarding-refresh-04-live-flow",
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
            position={[0, portrait ? 1.78 : 1.6, 0]}
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
            position={[0, portrait ? 1.68 : 1.34, 0]}
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
