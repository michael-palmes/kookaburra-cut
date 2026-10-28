import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 4: a laptop with a screen recording beside a handset with another. */
export default defineScene({
  id: "long-laptop",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    const scale = portrait ? 0.45 : 0.75;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        <Device
          model="macbook-pro-16"
          media={{ src: "assets/screen-06.mp4", kind: "video" }}
          placement={{
            position: [portrait ? 0 : -0.4, portrait ? 0.4 : 0, 0],
            rotationDeg: [8, 10, 0],
            scale,
          }}
        />
        <Device
          model="iphone-17-pro"
          media={{ src: "assets/screen-13.mp4", kind: "video", startMs: 1200 }}
          placement={{
            position: [portrait ? 0.3 : 1.3, portrait ? -0.7 : -0.2, 0.4],
            rotationDeg: [0, -18, 0],
            scale: scale * 0.8,
          }}
        />
      </group>
    );
  },
});
