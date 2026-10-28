import { Device, defineScene, useFormat, useTheme } from "@kookaburra/toolkit";

/** Memory gate scene 2: the foldable opens on the sidecar's device track, both displays playing video. */
export default defineScene({
  id: "long-unfold",
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
          foldDeg={0}
          media={{ src: "assets/screen-03.mp4", kind: "video", startOn: "open" }}
          coverMedia={{ src: "assets/screen-04.mp4", kind: "video" }}
          placement={{ position: [0, 0, 0], rotationDeg: [5, -14, 0], scale: portrait ? 0.5 : 0.9 }}
        />
      </group>
    );
  },
});
