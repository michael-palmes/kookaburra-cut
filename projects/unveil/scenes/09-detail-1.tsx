import {
  Device,
  DeviceScreenAnchor,
  defineScene,
  deviceScreenRect,
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
  id: "unveil-09-detail-1",
  durationMs: 1875,
  Scene() {
    const [hero] = useSceneDevices();
    const { localMs } = useTimeline();
    if (!hero) return null;
    const [u0, v0] = mediaPixelToScreenUv(hero.model, [CARD_PX[0], CARD_PX[1]], MEDIA);
    const [u1, v1] = mediaPixelToScreenUv(hero.model, [CARD_PX[2], CARD_PX[3]], MEDIA);
    const screen = deviceScreenRect(hero.model);
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
          <DeviceScreenAnchor u={(u0 + u1) / 2} v={(v0 + v1) / 2} lift={0}>
            <group position={[offset[0], offset[1], 0]}>
              <DepthProxy
                width={(u1 - u0) * screen.width * SCALE * 0.99}
                height={(v1 - v0) * screen.height * SCALE * 0.99}
                z={lift}
              />
            </group>
          </DeviceScreenAnchor>
        </Device>
      </SceneStage>
    );
  },
});
