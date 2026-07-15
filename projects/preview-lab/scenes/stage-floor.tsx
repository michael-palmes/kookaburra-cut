import { Device, defineScene, SceneStage, useFormat, useSceneDevices } from "@kookaburra/toolkit";

/**
 * Preview Lab — stage/backdrop sample for the "floor" option. DEV-ONLY: rendered by `pnpm kookaburra:run --action option-previews`
 * into the committed picker preview stills (src/assets/option-previews/). The option
 * under preview lives in the SIDECAR, exactly as the app's picker writes it.
 */
export default defineScene({
  id: "lab-stage-floor",
  durationMs: 1000,
  Scene() {
    const format = useFormat();
    const portrait = format.aspect < 1;
    const devices = useSceneDevices();
    return (
      <SceneStage>
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              scale: (d.placement?.scale ?? 1) * (portrait ? 0.8 : 0.92),
            }}
          />
        ))}
      </SceneStage>
    );
  },
});
