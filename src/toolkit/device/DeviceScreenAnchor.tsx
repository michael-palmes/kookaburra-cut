import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { V3 } from "../types";
import type { DeviceId, DeviceScreenRect } from "./catalog";
import {
  type DeviceScreenDisplay,
  deviceScreenFrame,
  deviceScreenRect,
  SCREEN_LIFT,
} from "./screenAnchor";

/** What a `Device` hands its children: the model it renders and this frame's hinge angles. */
export interface DeviceScreenContextValue {
  model: DeviceId;
  /** What this build renders (Android when `model` is unavailable); anchors use its screen. */
  renderModel: DeviceId;
  lidDeg?: number;
  foldDeg?: number;
}

export const DeviceScreenContext = createContext<DeviceScreenContextValue | null>(null);

export interface DeviceScreen extends DeviceScreenContextValue {
  rect: DeviceScreenRect;
  /** Foldables only: the outside display. */
  coverRect?: DeviceScreenRect;
  /** A screen point in the device's fitted frame (placement scale 1), at this frame's hinge pose. */
  local: (u: number, v: number, lift?: number, display?: DeviceScreenDisplay) => V3;
}

/** Inside a `Device`: the screen it renders this frame, else null. */
export function useDeviceScreen(): DeviceScreen | null {
  const context = useContext(DeviceScreenContext);
  if (!context) return null;
  const { renderModel, lidDeg, foldDeg } = context;
  const cover = deviceScreenRect(renderModel, "cover");
  const rect = deviceScreenRect(renderModel);
  return {
    ...context,
    rect,
    ...(cover !== rect ? { coverRect: cover } : {}),
    local: (u, v, lift = SCREEN_LIFT, display) =>
      deviceScreenFrame(renderModel, u, v, lift, { display, lidDeg, foldDeg }).position,
  };
}

export interface DeviceScreenAnchorProps {
  /** 0 at the display's left edge to 1 at its right. */
  u: number;
  /** 0 at the display's top edge to 1 at its bottom (media pixel order). */
  v: number;
  /** Off the glass along the display's normal, in fitted units (default `SCREEN_LIFT`). */
  lift?: number;
  /** A foldable's display (default `"main"`, the inside one). */
  display?: DeviceScreenDisplay;
  children?: ReactNode;
}

/** Pins its children to a point on the parent `Device`'s screen, in the screen's own plane (x right, y up, +z out of the glass, fitted units scaled with the device), so they follow float, rotation, intro, scale and a laptop's lid. */
export function DeviceScreenAnchor({ u, v, lift, display, children }: DeviceScreenAnchorProps) {
  const context = useContext(DeviceScreenContext);
  useEffect(() => {
    if (!context) console.warn("DeviceScreenAnchor renders nothing outside a <Device>");
  }, [context]);
  if (!context) return null;
  const { position, tiltX } = deviceScreenFrame(context.renderModel, u, v, lift, {
    display,
    lidDeg: context.lidDeg,
    foldDeg: context.foldDeg,
  });
  return (
    <group position={position} rotation={[tiltX, 0, 0]}>
      {children}
    </group>
  );
}
