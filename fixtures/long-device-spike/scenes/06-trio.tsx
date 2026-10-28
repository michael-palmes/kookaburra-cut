import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

const SCREENS = ["assets/screen-10.mp4", "assets/screen-11.mp4", "assets/screen-12.mp4"];

/** Memory gate scene 6: three handsets in a row, three recordings at once. */
export default defineScene({
  id: "long-trio",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    const spread = portrait ? 0.5 : 1.1;
    const scale = portrait ? 0.4 : 0.7;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        {SCREENS.map((src, i) => (
          <Device
            key={src}
            model="iphone-17-pro"
            media={{ src, kind: "video", startMs: i * 300 }}
            placement={{
              position: [(i - 1) * spread, 0, 0],
              rotationDeg: [0, (1 - i) * 12, 0],
              scale,
            }}
            motion={{ preset: "float" }}
          />
        ))}
      </group>
    );
  },
});
