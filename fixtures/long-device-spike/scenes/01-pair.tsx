import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 1: two handsets, each playing its own screen recording. */
export default defineScene({
  id: "long-pair",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    const spread = portrait ? 0.55 : 1;
    const scale = portrait ? 0.55 : 0.85;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        <Device
          model="iphone-17-pro"
          media={{ src: "assets/screen-01.mp4", kind: "video" }}
          placement={{ position: [-0.85 * spread, 0, 0], rotationDeg: [0, 14, 0], scale }}
          motion={{ preset: "float" }}
        />
        <Device
          model="iphone-17-pro"
          media={{ src: "assets/screen-02.mp4", kind: "video", startMs: 400 }}
          placement={{ position: [0.85 * spread, 0, 0], rotationDeg: [0, -14, 0], scale }}
          motion={{ preset: "float" }}
        />
      </group>
    );
  },
});
