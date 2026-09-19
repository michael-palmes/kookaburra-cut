import {
  AnimatedHeadline,
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";

/** Preset: a foldable that opens from its outside screen onto the app inside; the fold lives on the sidecar's device track. */
export default defineScene({
  id: "preset-duo-unfold",
  durationMs: 4600,
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
            to={900}
            position={[0, portrait ? 1.62 : 1.5, 0]}
            fontSize={portrait ? 0.23 : 0.42}
          />
        ) : null}
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              // The open device is landscape, so a tall frame gives it far less room than a handset.
              scale: (d.placement?.scale ?? 1) * (portrait ? 0.46 : 0.9),
            }}
          />
        ))}
      </SceneStage>
    );
  },
});
