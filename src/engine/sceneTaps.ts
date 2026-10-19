/** Sidecar taps: which taps draw where, and their ring sizes. The pulse itself is the editor's tap curve (tapCurve.ts), so a scene tap and an edited recording's tap move alike. */

import type { SceneDoc, SceneDocTap } from "./sceneDocSchema";

/** A world-space tap's outer ring radius at scale 1, world units. */
export const TAP_RING_RADIUS = 0.12;
/** A screen tap's outer ring radius as a fraction of the display's width. */
export const DEVICE_TAP_RADIUS_FRACTION = 0.1;

export type WorldTap = SceneDocTap & { position: [number, number, number] };
export type ScreenTap = SceneDocTap & { screenUv: [number, number]; device: string };

/** Taps placed in world space (the host draws them). */
export function worldTaps(doc: SceneDoc | null | undefined): WorldTap[] {
  return (doc?.taps ?? []).filter(
    (tap): tap is WorldTap => tap.position !== undefined && tap.screenUv === undefined,
  );
}

/** Taps on one sidecar device's screen (that device draws them). */
export function screenTaps(
  doc: SceneDoc | null | undefined,
  deviceId: string | undefined,
): ScreenTap[] {
  if (deviceId === undefined) return [];
  return (doc?.taps ?? []).filter(
    (tap): tap is ScreenTap => tap.screenUv !== undefined && tap.device === deviceId,
  );
}
