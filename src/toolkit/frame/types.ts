/** Overlay ("frame") types: a camera-locked panel with a shaped cutout the scene renders through. Named `Frame` in code because `overlay` already means the persistent transition layer in the compositor (`FrameCameraPlan.overlay`, `ComposerState.overlayPass`). See docs/overlays.md. */

import type { SceneTextAlign } from "../../engine/sceneDocSchema";

export type FrameShape = "rect" | "rounded-rect" | "squircle" | "circle" | "capsule";

/** Which end of the split axis the cutout sits on; the axis itself follows the aspect, so one config serves every format. */
export type FrameSide = "start" | "end";

export type FrameDecorationShape = "none" | "circle";

/** "above" draws over the cutout (the deliberate breakout); "below" tucks behind it. */
export type FrameDecorationLayer = "above" | "below";

export interface FrameCutoutSpec {
  shape: FrameShape;
  /** Corner radius as a fraction of the cutout's shorter edge, `rounded-rect` only. */
  radius?: number;
  /** Fraction of the frame's split axis the cutout column/row occupies. */
  size?: number;
  side?: FrameSide;
  /** Margin between cutout and frame edge, as a fraction of the shorter frame edge. */
  inset?: number;
}

export interface FrameChipSpec {
  label: string;
  /** Theme token id ("accent", "muted", "text", "background") or a hex override. */
  colour?: string;
  /** Emoji, or a project-relative asset path. */
  icon?: string;
}

export interface FrameDecorationSpec {
  id: string;
  /** Project-relative asset path. */
  src: string;
  /** Centre in frame-relative coords, -1..1 on both axes. */
  position: [number, number];
  /** Width as a fraction of the frame width. */
  size: number;
  /** Clockwise rotation in degrees about the decoration's centre; absent (or 0) is upright. */
  rotationDeg?: number;
  shape?: FrameDecorationShape;
  layer?: FrameDecorationLayer;
}

export interface FrameSpec {
  enabled?: boolean;
  cutout: FrameCutoutSpec;
  /** Theme token id, or a hex override. */
  background?: string;
  /** Emoji or asset path, drawn above the title. */
  icon?: string;
  chip?: FrameChipSpec;
  decorations?: FrameDecorationSpec[];
  textAlign?: SceneTextAlign;
  /** Overlay claims the scene's title/subtitle/bullets and suppresses the in-world headline. */
  claimsSceneText?: boolean;
}

/** A scene sidecar's override of the deck frame. `cutout` is optional here (unlike `FrameSpec`) so a scene can restyle just the colour or chip without restating the shape; when present it replaces the deck's outright. */
export interface FrameOverrideSpec extends Omit<FrameSpec, "cutout"> {
  cutout?: FrameCutoutSpec;
}
