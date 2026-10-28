import { Device, defineScene, useFormat, useSceneDevices, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 5: a before/after comparison, both sides playing video (side B swaps one screen). */
export default defineScene({
  id: "long-compare",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    const devices = useSceneDevices();
    const spread = portrait ? 0.62 : 1;
    const scaleMult = portrait ? 0.62 : 0.92;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        {devices.map((d) => (
          <Device
            key={d.id}
            {...d}
            placement={{
              ...d.placement,
              position: [
                (d.placement?.position?.[0] ?? 0) * spread,
                d.placement?.position?.[1] ?? -0.2,
                d.placement?.position?.[2] ?? 0,
              ],
              scale: (d.placement?.scale ?? 1) * scaleMult,
            }}
          />
        ))}
      </group>
    );
  },
});
