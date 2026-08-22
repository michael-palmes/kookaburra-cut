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
 * Compare Spike scene 3: an ANIMATED angled sweep. The divider rides track keys (0.15 to
 * 0.85) on a 60-degree line with a feathered edge, over a second theme pair; same composition
 * as scene 2, the compare block lives in the sidecar.
 */
export default defineScene({
  id: "compare-transition-spike-sweep",
  durationMs: 2000,
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
