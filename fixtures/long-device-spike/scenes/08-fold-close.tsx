import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 8: the foldable closes on the sidecar's device track, handing over to its cover display. */
export default defineScene({
  id: "long-fold-close",
  durationMs: 8000,
  Scene() {
    const theme = useTheme();
    const portrait = useFormat().aspect < 1;
    return (
      <group>
        <color attach="background" args={[theme.colors.background]} />
        <Device
          id="d1"
          model="iphone-duo"
          foldDeg={180}
          media={{ src: "assets/screen-03.mp4", kind: "video", startMs: 2000 }}
          coverMedia={{ src: "assets/screen-04.mp4", kind: "video", startMs: 2000 }}
          placement={{ position: [0, 0, 0], rotationDeg: [5, 14, 0], scale: portrait ? 0.5 : 0.9 }}
        />
      </group>
    );
  },
});
