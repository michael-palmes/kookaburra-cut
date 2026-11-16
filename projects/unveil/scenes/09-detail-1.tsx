import {
  Device,
  defineScene,
  mediaPixelToScreenUv,
  ramp,
  SceneStage,
  ScreenRegion,
  useSceneDevices,
  useTimeline,
} from "@kookaburra/toolkit";

const MEDIA = { width: 1206, height: 2622 };
const CARD_PX = [48, 450, 1158, 1048];
const CORNER = 0.075;
const LIFT: [number, number] = [0.3, 0.32];
const SCALE = 1.1;
const TOWARD_LENS: [number, number] = [-0.9662, -1.016];

export default defineScene({
  id: "unveil-09-detail-1",
  durationMs: 1875,
  Scene() {
    const [hero] = useSceneDevices();
    const { localMs } = useTimeline();
    if (!hero) return null;
    const [u0, v0] = mediaPixelToScreenUv(hero.model, [CARD_PX[0], CARD_PX[1]], MEDIA);
    const [u1, v1] = mediaPixelToScreenUv(hero.model, [CARD_PX[2], CARD_PX[3]], MEDIA);
    const lift = LIFT[0] + (LIFT[1] - LIFT[0]) * ramp(localMs, 0, 1875, "linear");
    const offset: [number, number] = [TOWARD_LENS[0] * lift, TOWARD_LENS[1] * lift];
    return (
      <SceneStage floorY={-1.905}>
        <Device {...hero}>
          <ScreenRegion
            rect={[u0, v0, u1, v1]}
            at={-100}
            durationMs={50}
            lift={lift}
            scale={SCALE}
            offset={offset}
            cornerRadius={CORNER}
            shadow={0.55}
            glassEdge={0.04}
          />
        </Device>
      </SceneStage>
    );
  },
});
