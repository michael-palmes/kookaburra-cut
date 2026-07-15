import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

/**
 * Showcase tour scene 5 — Abyss: dramatic low key + long shadows on the navy gradient,
 * slow word fade (120ms stagger), camera drifting in from the sidecar keys.
 */
export default defineScene({
  id: "tour-abyss-camera",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Down in the deep");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={1100}
          position={[0, portrait ? 1.9 : 1.72, 0]}
          fontSize={portrait ? 0.23 : 0.42}
        />
        {devices.map((d) => {
          const scale = (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92);
          return (
            <Device
              key={d.id}
              {...d}
              placement={{
                ...d.placement,
                position: d.placement?.position ?? [0, -1.5 + 1.3 * scale, 0],
                scale,
              }}
            />
          );
        })}
      </SceneStage>
    );
  },
});
