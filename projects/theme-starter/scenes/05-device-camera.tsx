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
 * Theme starter scene 5, device + title with a camera move: the sidecar's per-scene
 * camera keys orbit-push toward a floating device (v7 · M5). Composition here, camera and
 * content in `scenes/05-device-camera.json`.
 */
export default defineScene({
  id: "starter-device-camera",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Get closer");
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
