import { AnimatedHeadline, Device, useSceneDevices, useSceneText } from "@kookaburra/toolkit";
import type { ReactNode } from "react";
import { SceneStageContext } from "../../../src/toolkit/stage/context";

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
