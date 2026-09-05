import {
  AnimatedHeadline,
  Device,
  defineScene,
  resolveDeviceLayout,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneDoc,
  useSceneText,
  useTheme,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "comparison",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const textWidth = format.frame.width - format.safe.left - format.safe.right;
    const safeTop = format.frame.height / 2 - format.safe.top;
    const title = useSceneText("title");
    const subtitle = useSceneText("subtitle");
    const labels = [
      useSceneText("beforeLabel", "", "embedded"),
      useSceneText("afterLabel", "", "embedded"),
    ];
    const labelKeys = ["beforeLabel", "afterLabel"];
    const devices = useSceneDevices();
    const doc = useSceneDoc();
    const placements = doc?.deviceLayout
      ? resolveDeviceLayout(devices, doc.deviceLayout, format)
      : devices.map((d) => d.placement ?? {});
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
        {devices.map((d, i) => {
          const placement = placements[i] ?? {};
          const x = placement.position?.[0] ?? 0;
          const label = i < 2 ? labels[i] : null;
          return (
            <group key={d.id}>
              {label ? (
                <AnimatedHeadline
                  text={label}
                  textKey={labelKeys[i]}
                  managedTextRole="embedded"
                  face="body"
                  defaultColor={i === 0 ? "muted" : "accent"}
                  from={350 + i * 150}
                  to={1050 + i * 150}
                  position={[x, portrait ? 0.85 : 1.0, 0]}
                  fontSize={portrait ? 0.13 : 0.18}
                />
              ) : null}
              <Device {...d} placement={placement} />
            </group>
          );
        })}
      </SceneStage>
    );
  },
});
