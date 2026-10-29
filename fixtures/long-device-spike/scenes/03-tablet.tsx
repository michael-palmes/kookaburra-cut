import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 3: a tablet on a slow turntable with a screen recording. */
export default defineScene({
  id: "long-tablet",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        <Device
          model="ipad-pro-13"
          media={{ src: "assets/screen-05.mp4", kind: "video" }}
          placement={{
            position: [0, 0, 0],
            rotationDeg: [6, -20, 0],
            scale: portrait ? 0.45 : 0.8,
          }}
          motion={{ preset: "turntable", degPerSec: 6 }}
        />
      </group>
    );
  },
});
