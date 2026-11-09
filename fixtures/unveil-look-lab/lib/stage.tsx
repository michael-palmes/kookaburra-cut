import {
  AnimatedHeadline,
  Device,
  ScreenRegion,
  useSceneDevices,
  useSceneText,
} from "@kookaburra/toolkit";
import { type ReactNode, useLayoutEffect, useMemo } from "react";
import { BufferAttribute, PlaneGeometry } from "three";
import { SceneStageContext } from "../../../src/toolkit/stage/context";

/** A lit matte floor whose albedo falls to black with distance, so pools land on it and it dissolves into the void with no horizon. Lambert, because a Standard floor mirrors the strip environment. */
export function LitFloor({
  y,
  color = "#100d0b",
  centre = [0, 0],
  fade = [4, 14],
}: {
  y: number;
  color?: string;
  centre?: [number, number];
  fade?: [number, number];
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
    <mesh geometry={geometry} position={[0, y, 0]} receiveShadow>
      <meshLambertMaterial color={color} vertexColors />
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

/** The handset with its "This week, sorted" card lifted off the glass. */
export function CardDevice({ glassEdge }: { glassEdge?: number }) {
  const [hero] = useSceneDevices();
  if (!hero) return null;
  return (
    <Device {...hero}>
      <ScreenRegion
        rect={[0.04, 0.172, 0.96, 0.4]}
        at={600}
        scale={1.12}
        offset={[0.05, -0.3]}
        glassEdge={glassEdge}
      />
    </Device>
  );
}

export function Title({
  textKey,
  position,
  fontSize,
  tiltDeg = 0,
  face,
  colour,
}: {
  textKey: string;
  position: [number, number, number];
  fontSize: number;
  tiltDeg?: number;
  face?: "headline" | "body";
  colour?: "text" | "muted";
}) {
  const text = useSceneText(textKey, "");
  if (!text) return null;
  return (
    <group position={position} rotation-x={(tiltDeg * Math.PI) / 180}>
      <AnimatedHeadline
        text={text}
        textKey={textKey}
        preset="static"
        face={face}
        defaultColor={colour}
        fontSize={fontSize}
      />
    </group>
  );
}
