import {
  Device,
  defineScene,
  mediaPixelToScreenUv,
  ramp,
  SceneStage,
  ScreenRegion,
  useBeatGrid,
  useSceneDevices,
  useTimeline,
} from "@kookaburra/toolkit";

const MEDIA = { width: 1206, height: 2622 };
const CARD_PX = [48, 450, 1158, 1048];
const CORNER = 0.075;
const FIRST_BAR = 14;
const LIFT = 0.15;
const FLOAT_LIFT = 0.3;
const FLOAT_SCALE = 1.1;
const TOWARD_LENS: [number, number] = [-0.9662, -1.016];

export default defineScene({
  id: "unveil-06-proof-1",
  durationMs: 3750,
  Scene() {
    const [hero] = useSceneDevices();
    const { localMs } = useTimeline();
    const grid = useBeatGrid();
    const at = (bar: number, beat = 1) =>
      grid ? grid.bar(bar, beat) : ((bar - FIRST_BAR) * 4 + beat - 1) * 468.75;
    if (!hero) return null;
    const [u0, v0] = mediaPixelToScreenUv(hero.model, [CARD_PX[0], CARD_PX[1]], MEDIA);
    const [u1, v1] = mediaPixelToScreenUv(hero.model, [CARD_PX[2], CARD_PX[3]], MEDIA);
    const liftAt = at(14, 3);
    const float = ramp(localMs, at(15), at(16), "inOutSine");
    const lift = LIFT + (FLOAT_LIFT - LIFT) * float;
    const scale = 1.06 + (FLOAT_SCALE - 1.06) * float;
    return (
      <SceneStage floorY={-1.905}>
        <Device {...hero}>
          <ScreenRegion
            rect={[u0, v0, u1, v1]}
            at={liftAt}
            durationMs={700}
            lift={lift}
            scale={scale}
            offset={[TOWARD_LENS[0] * lift, TOWARD_LENS[1] * lift]}
            cornerRadius={CORNER}
            shadow={0.55}
            glassEdge={0.04}
          />
        </Device>
      </SceneStage>
    );
  },
});
