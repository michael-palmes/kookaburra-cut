import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 7: the foldable open flat on a slow turntable, its inside display playing. */
export default defineScene({
  id: "long-open",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        <Device
          model="iphone-duo"
          foldDeg={180}
          media={{ src: "assets/screen-14.mp4", kind: "video" }}
          placement={{ position: [0, 0, 0], rotationDeg: [4, 10, 0], scale: portrait ? 0.5 : 0.85 }}
          motion={{ preset: "turntable", degPerSec: 5 }}
        />
      </group>
    );
  },
});
