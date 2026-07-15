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
 * Theme starter scene 2 — a catalog device turning under the headline, playing the demo
 * video on its screen (the deterministic clip-frame pipeline). Devices and text are
 * sidecar-driven; when a device has no explicit position it stands ON the stage floor
 * (base at −1.5, half the auto-fit height × scale).
 */
export default defineScene({
  id: "starter-device-video",
  durationMs: 3200,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Show the product");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
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
