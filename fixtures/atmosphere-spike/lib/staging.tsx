import { AnimatedHeadline, Device, useSceneDevices, useSceneText } from "@kookaburra/toolkit";
import { type ReactNode, useLayoutEffect, useMemo } from "react";
import { BufferAttribute, PlaneGeometry } from "three";
import { SceneStageContext } from "../../../src/toolkit/stage/context";

export const NAME_FLOOR_Y = -1.95;

/** A lit matte floor whose albedo falls to black with distance, so it dissolves into the void instead of drawing a horizon. The cyclorama is unlit by contract, so gobo pools need their own receiver. */
export function LitFloor({
  y,
  color = "#100d0b",
  roughness = 0.62,
  centre = [0, 0],
  fade = [4, 14],
  noOcclude = false,
}: {
  y: number;
  color?: string;
  roughness?: number;
  centre?: [number, number];
  fade?: [number, number];
  /** Leave the floor out of the screen-space rays' occlusion pass. */
  noOcclude?: boolean;
}) {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(80, 80, 96, 96).rotateX(-Math.PI / 2);
    const pos = plane.getAttribute("position");
    const colours = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i) - centre[0], pos.getZ(i) - centre[1]);
      const t = Math.min(1, Math.max(0, (r - fade[0]) / (fade[1] - fade[0])));
      const v = 1 - t * t * (3 - 2 * t);
      colours.set([v, v, v], i * 3);
    }
    plane.setAttribute("color", new BufferAttribute(colours, 3));
    return plane;
  }, [centre[0], centre[1], fade[0], fade[1]]);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      position={[0, y, 0]}
      receiveShadow
      userData={noOcclude ? { atmosNoOcclude: true } : undefined}
    >
      <meshStandardMaterial color={color} roughness={roughness} metalness={0} vertexColors />
    </mesh>
  );
}

/** Lets the sidecar devices cast and receive real shadows without staging a backdrop. */
export function ShadowCasters({ children, floorY }: { children: ReactNode; floorY: number }) {
  return (
    <SceneStageContext.Provider value={{ mapShadows: true, floorY }}>
      {children}
    </SceneStageContext.Provider>
  );
}

export function SceneDevices() {
  const devices = useSceneDevices();
  return (
    <>
      {devices.map((d) => (
        <Device key={d.id} {...d} />
      ))}
    </>
  );
}

/** The name on the right, turned to face a camera that looks up at the set. */
export function NameTitle({
  position,
  fontSize,
  tiltDeg = 0,
}: {
  position: [number, number, number];
  fontSize: number;
  tiltDeg?: number;
}) {
  const title = useSceneText("title", "Meet Fairywren.");
  return (
    <group position={position} rotation-x={(tiltDeg * Math.PI) / 180}>
      <AnimatedHeadline text={title} textKey="title" from={0} to={300} fontSize={fontSize} />
    </group>
  );
}

/** The name shot: the handset on the left third, the name on the right. */
export function NameShot({ castShadows = false }: { castShadows?: boolean }) {
  const title = useSceneText("title", "Meet Fairywren.");
  const devices = castShadows ? (
    <ShadowCasters floorY={NAME_FLOOR_Y}>
      <SceneDevices />
    </ShadowCasters>
  ) : (
    <SceneDevices />
  );
  return (
    <>
      <AnimatedHeadline
        text={title}
        textKey="title"
        from={0}
        to={300}
        position={[1.62, 0.02, 0]}
        fontSize={0.56}
      />
      {devices}
    </>
  );
}
