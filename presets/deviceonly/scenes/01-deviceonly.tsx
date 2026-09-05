import {
  Device,
  defineScene,
  SceneStage,
  useFormat,
  useSceneDevices,
  useSceneDoc,
} from "@kookaburra/toolkit";

export default defineScene({
  id: "deviceonly",
  durationMs: 3000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const devices = useSceneDevices();
    const laidOut = useSceneDoc()?.deviceLayout !== undefined;
    return (
      <SceneStage>
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={
              laidOut
                ? d.placement
                : {
                    ...d.placement,
                    scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
                  }
            }
          />
        ))}
      </SceneStage>
    );
  },
});
