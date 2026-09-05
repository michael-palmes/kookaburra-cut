import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneDoc,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "device",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const textWidth = format.frame.width - format.safe.left - format.safe.right;
    const safeTop = format.frame.height / 2 - format.safe.top;
    const title = useSceneText("title");
    const subtitle = useSceneText("subtitle");
    const devices = useSceneDevices();
    const doc = useSceneDoc();
    const laidOut = doc?.deviceLayout !== undefined;
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={900}
            position={[0, portrait ? safeTop : 1.72, 0]}
            anchorY={portrait ? "top" : undefined}
            fontSize={portrait ? 0.23 : 0.42}
            maxWidth={textWidth}
            textAlign="center"
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
            position={[0, portrait ? safeTop - (title ? 0.9 : 0) : 1.34, 0]}
            anchorY={portrait ? "top" : undefined}
            fontSize={(portrait ? 0.23 : 0.42) / theme.typography.scale ** 4}
            maxWidth={textWidth}
            textAlign="center"
          />
        ) : null}
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={
              laidOut
                ? d.placement
                : {
                    ...d.placement,
                    scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
                  }
            }
          />
        ))}
      </SceneStage>
    );
  },
});
