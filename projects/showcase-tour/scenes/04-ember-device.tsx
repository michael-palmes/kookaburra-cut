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
 * Showcase tour scene 4 — Ember: black titanium turning on the charcoal floor under the
 * warm key, gold accent headline. Device + media from the sidecar.
 */
export default defineScene({
  id: "tour-ember-device",
  durationMs: 3200,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const headline = useSceneText("headline", "Warm studio");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        <AnimatedHeadline
          text={headline}
          textKey="headline"
          from={200}
          to={900}
          defaultColor="accent"
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
