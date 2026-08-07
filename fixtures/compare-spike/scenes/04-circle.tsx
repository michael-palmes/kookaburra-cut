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

/**
 * Compare Spike: a STATIC circle window (the after inside a growing spotlight), line ring + after tint.
 * Same composition as scene 2; the compare block lives in the sidecar.
 */
export default defineScene({
  id: "compare-circle",
  durationMs: 1600,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    const labels = [useSceneText("beforeLabel"), useSceneText("afterLabel")];
    const labelKeys = ["beforeLabel", "afterLabel"];
    const devices = useSceneDevices();
    const spread = portrait ? 0.62 : 1;
    const scaleMult = portrait ? 0.62 : 0.92;
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={150}
            to={800}
            position={[0, portrait ? 1.9 : 1.72, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        {devices.map((d, i) => {
          const x = (d.placement?.position?.[0] ?? 0) * spread;
          const label = i < 2 ? labels[i] : null;
          return (
            <group key={d.id}>
              {label ? (
                <AnimatedHeadline
                  text={label}
                  textKey={labelKeys[i]}
                  face="body"
                  defaultColor={i === 0 ? "muted" : "accent"}
                  from={300 + i * 150}
                  to={950 + i * 150}
                  position={[x, portrait ? 0.62 : 1.0, 0]}
                  fontSize={portrait ? 0.13 : 0.18}
                />
              ) : null}
              <Device
                {...d}
                placement={{
                  ...d.placement,
                  position: [
                    x,
                    d.placement?.position?.[1] ?? -0.3,
                    d.placement?.position?.[2] ?? 0,
                  ],
                  scale: (d.placement?.scale ?? 1) * scaleMult,
                }}
              />
            </group>
          );
        })}
      </SceneStage>
    );
  },
});
