/** Overlay ("frame") types: a camera-locked panel with a shaped cutout the scene renders through. Named `Frame` in code because `overlay` already means the persistent transition layer in the compositor (`FrameCameraPlan.overlay`, `ComposerState.overlayPass`). See docs/overlays.md. */

import type { SceneTextAlign } from "../../engine/sceneDocSchema";
import type { GradientSpec } from "../../theme/tokens";

/** `"none"` removes the cutout entirely: the panel owns the whole frame and `side`/`size`/`inset`/`radius` are no-ops. */
export type FrameShape = "rect" | "rounded-rect" | "squircle" | "circle" | "capsule" | "none";

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

/** Where a hosted chart sits in the panel column: in the band under the text, or in place of it (the panel then draws no editorial content at all). */
export type FrameChartPosition = "below" | "replace";

/** The panel's chart slot: presence and layout only. The chart DEFINITION stays in the scene document's `chart` block (with `mount: "panel"`), so one chart is authored, edited and animated the same way wherever it lands. */
export interface FrameChartSlot {
  /** `false` switches an inherited deck slot off for this scene (the `FrameSpec.enabled` idiom). */
  enabled?: boolean;
  /** Band the chart takes off the column, as a fraction of its height (clamped 0.1..1); defaults to 0.55 under text, the whole column when it replaces it. */
  height?: number;
  position?: FrameChartPosition;
}

/** Which theme face a text decoration types in. */
export type FrameDecorationFace = "headline" | "body";

/** One positioned mark on the panel: an image or a line of text, EXACTLY one of `src`/`text`. Decoration text lives here rather than in the document's `text` map because it is positioned art, not body copy, and several decorations each need their own string. */
export interface FrameDecorationSpec {
  id: string;
  /** Project-relative asset path; the image decoration. */
  src?: string;
  /** The text decoration's line (troika, theme fonts); `\n` is the only break. */
  text?: string;
  /** Text fill: a theme token id ("accent", "muted", "text", "background") or a hex override. Text decorations only. */
  colour?: string;
  /** Theme face for a text decoration; default "headline". */
  face?: FrameDecorationFace;
  /** Explicit font ("Family" or "Family@weight") replacing the face for a text decoration. */
  font?: string;
  /** Line spacing as a multiple of the font size (0.8..2); absent means the font's normal. Text decorations only. */
  lineHeight?: number;
  /** Centre in frame-relative coords, -1..1 on both axes. */
  position: [number, number];
  /** An image's width, or a text decoration's font size, as a fraction of the frame width. */
  size: number;
  /** Clockwise rotation in degrees about the decoration's centre; absent (or 0) is upright. */
  rotationDeg?: number;
  /** Images only: `circle` crops the plane to a disc. */
  shape?: FrameDecorationShape;
  layer?: FrameDecorationLayer;
}

/** The panel fill, beyond the flat colour a plain string still means: a baked gradient, a cover-fit project image, or nothing at all (`transparent` paints no panel, so the scene fills the frame behind the overlay's content). Mirrors the stage's `ThemeBackground` vocabulary for the types it shares. */
export type FramePanelBackground =
  | { type: "transparent" }
  /** Theme token id, or a hex override (the string form, spelled out). */
  | { type: "color"; color: string }
  /** `gradient` names a THEME gradient; `spec` carries an inline self-contained one (the picker's write-through). `spec` wins when both are present. */
  | { type: "gradient"; gradient?: string; spec?: GradientSpec }
  /** Project-relative asset path, cover-cropped to the frame. */
  | { type: "image"; src: string };

export interface FrameSpec {
  enabled?: boolean;
  cutout: FrameCutoutSpec;
  /** The panel fill: a theme token id, a hex override, or a `FramePanelBackground` object. Absent takes the neutral panel the theme suits. */
  background?: string | FramePanelBackground;
  /** Emoji or asset path, drawn above the title. */
  icon?: string;
  chip?: FrameChipSpec;
  /** Hosts the scene's panel-mounted chart in the column; absent means the panel is text only. */
  chart?: FrameChartSlot;
  decorations?: FrameDecorationSpec[];
  textAlign?: SceneTextAlign;
  /** Overlay claims the scene's title/subtitle/bullets and suppresses the in-world headline. */
  claimsSceneText?: boolean;
}

/** A scene sidecar's override of the deck frame. `cutout` is optional here (unlike `FrameSpec`) so a scene can restyle just the colour or chip without restating the shape; when present it replaces the deck's outright. */
export interface FrameOverrideSpec extends Omit<FrameSpec, "cutout"> {
  cutout?: FrameCutoutSpec;
}
