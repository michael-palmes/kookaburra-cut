import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

/** Feature Deep Dive 4: one caption over the near key, then the rig flies the detail on its own. */
export default defineScene({
  id: "feature-deep-dive-04-detail-push",
  durationMs: 4000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const title = useSceneText("title");
    const devices = useSceneDevices();
    return (
      <SceneStage>
        {title ? (
          <AnimatedHeadline
            text={title}
            textKey="title"
            from={200}
            to={850}
            outAt={1800}
            position={[0, 0.98, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.85),
            }}
          />
        ))}
      </SceneStage>
    );
  },
});
