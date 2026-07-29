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
 * Preview Lab: New-scene kind card for "Before / after". DEV-ONLY, rendered by
 * `pnpm kookaburra:run --action option-previews` into the committed kind-picker stills;
 * mirrors the scaffolded comparison-scene composition (a labelled symmetric pair) with
 * the scaffolder's current defaults.
 */
export default defineScene({
  id: "lab-kind-comparison",
  durationMs: 3000,
  Scene() {
    const theme = useTheme();
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    const subtitle = useSceneText("subtitle");
    const labels = [useSceneText("beforeLabel"), useSceneText("afterLabel")];
    const labelKeys = ["beforeLabel", "afterLabel"];
    const devices = useSceneDevices();
    // Portrait pulls the pair toward centre and shrinks it harder than a single device would.
    const spread = portrait ? 0.62 : 1;
    const scaleMult = portrait ? 0.62 : 0.92;
    return (
      <SceneStage>
        <color attach="background" args={[theme.colors.background]} />
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={900}
            position={[0, portrait ? 1.9 : 1.72, 0]}
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
                  from={350 + i * 150}
                  to={1050 + i * 150}
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
