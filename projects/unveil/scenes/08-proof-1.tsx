import {
  Device,
  DeviceScreenAnchor,
  defineScene,
  deviceScreenRect,
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

// Lens depth of field reads the depth buffer, which the lifted card never writes: this invisible plane gives it the card's depth.
function DepthProxy({ width, height, z }: { width: number; height: number; z: number }) {
  const r = Math.min(CORNER, width / 2, height / 2);
  const corners: [number, number][] = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  return (
    <group position={[0, 0, z]}>
      <mesh scale={[width, height - 2 * r, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial colorWrite={false} />
      </mesh>
      <mesh scale={[width - 2 * r, height, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial colorWrite={false} />
      </mesh>
      {corners.map(([sx, sy]) => (
        <mesh key={`${sx}${sy}`} position={[sx * (width / 2 - r), sy * (height / 2 - r), 0]}>
          <circleGeometry args={[r, 24]} />
          <meshBasicMaterial colorWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

export default defineScene({
  id: "unveil-08-proof-1",
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
    const screen = deviceScreenRect(hero.model);
    const liftAt = at(14, 3);
    const up = ramp(localMs, liftAt, liftAt + 700, "outCubic");
    const float = ramp(localMs, at(15), at(16), "inOutSine");
    const lift = LIFT + (FLOAT_LIFT - LIFT) * float;
    const scale = 1.06 + (FLOAT_SCALE - 1.06) * float;
    const grown = 1 + (scale - 1) * up;
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
          {up > 0 ? (
            <DeviceScreenAnchor u={(u0 + u1) / 2} v={(v0 + v1) / 2} lift={0}>
              <group position={[TOWARD_LENS[0] * lift * up, TOWARD_LENS[1] * lift * up, 0]}>
                <DepthProxy
                  width={(u1 - u0) * screen.width * grown * 0.99}
                  height={(v1 - v0) * screen.height * grown * 0.99}
                  z={lift * up}
                />
              </group>
            </DeviceScreenAnchor>
          ) : null}
        </Device>
      </SceneStage>
    );
  },
});
