/** Validation for the overlay ("frame") block, in `project.json` as the deck default and in a scene sidecar as the per-scene override. Same degrade-don't-crash contract as `parseSceneDoc`: a malformed optional field drops with a warning, a malformed `cutout` drops the whole block, nothing throws. PURE module (validation only). See docs/overlays.md. */

import type {
  FrameChipSpec,
  FrameCutoutSpec,
  FrameDecorationLayer,
  FrameDecorationShape,
  FrameDecorationSpec,
  FrameOverrideSpec,
  FrameShape,
  FrameSide,
  FrameSpec,
} from "../toolkit/frame/types";
import type { SceneTextAlign } from "./sceneDocSchema";

const SHAPES: FrameShape[] = ["rect", "rounded-rect", "squircle", "circle", "capsule"];
const SIDES: FrameSide[] = ["start", "end"];
const DECORATION_SHAPES: FrameDecorationShape[] = ["none", "circle"];
const DECORATION_LAYERS: FrameDecorationLayer[] = ["above", "below"];
const TEXT_ALIGNS: SceneTextAlign[] = ["left", "center", "right"];
/** Theme colour tokens (`theme/schema.ts` requires exactly these four). */
const COLOUR_TOKENS = ["background", "text", "accent", "muted"];
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColour(value: unknown): value is string {
  return typeof value === "string" && (COLOUR_TOKENS.includes(value) || HEX.test(value));
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseChip(raw: unknown, source: string): FrameChipSpec | undefined {
  if (!isRecord(raw)) {
    console.warn(`[frame] ${source}: chip isn't an object — dropped`);
    return undefined;
  }
  if (typeof raw.label !== "string" || raw.label.length === 0) {
    console.warn(`[frame] ${source}: chip needs a non-empty string "label" — dropped`);
    return undefined;
  }
  const chip: FrameChipSpec = { label: raw.label };
  if (raw.colour !== undefined) {
    if (isColour(raw.colour)) chip.colour = raw.colour;
    else console.warn(`[frame] ${source}: chip.colour isn't a theme token or hex — dropped`);
  }
  if (typeof raw.icon === "string" && raw.icon.length > 0) chip.icon = raw.icon;
  return chip;
}

function parseDecoration(
  raw: unknown,
  source: string,
  index: number,
): FrameDecorationSpec | undefined {
  const where = `decorations[${index}]`;
  if (!isRecord(raw)) {
    console.warn(`[frame] ${source}: ${where} isn't an object — dropped`);
    return undefined;
  }
  if (typeof raw.id !== "string" || typeof raw.src !== "string") {
    console.warn(`[frame] ${source}: ${where} needs string "id" + "src" — dropped`);
    return undefined;
  }
  const position = raw.position;
  if (!Array.isArray(position) || position.length !== 2) {
    console.warn(`[frame] ${source}: ${where}.position needs [x, y] — dropped`);
    return undefined;
  }
  const px = num(position[0]);
  const py = num(position[1]);
  const size = num(raw.size);
  if (px === undefined || py === undefined) {
    console.warn(`[frame] ${source}: ${where}.position needs finite numbers — dropped`);
    return undefined;
  }
  if (size === undefined || size <= 0) {
    console.warn(`[frame] ${source}: ${where}.size needs a positive number — dropped`);
    return undefined;
  }
  const decoration: FrameDecorationSpec = {
    id: raw.id,
    src: raw.src,
    position: [px, py],
    size,
  };
  if (DECORATION_SHAPES.includes(raw.shape as FrameDecorationShape)) {
    decoration.shape = raw.shape as FrameDecorationShape;
  }
  if (DECORATION_LAYERS.includes(raw.layer as FrameDecorationLayer)) {
    decoration.layer = raw.layer as FrameDecorationLayer;
  }
  const rotationDeg = num(raw.rotationDeg);
  if (rotationDeg !== undefined) {
    decoration.rotationDeg = rotationDeg;
  }
  return decoration;
}

/** Parses a deck frame (`project.json`), where a valid `cutout` is required: with no shape there is nothing to render through. */
export function parseFrameSpec(raw: unknown, source: string): FrameSpec | undefined {
  const spec = parseFrameOverride(raw, source);
  if (!spec) return undefined;
  if (!spec.cutout) {
    console.warn(`[frame] ${source}: cutout needs a valid "shape" — ignored`);
    return undefined;
  }
  return spec as FrameSpec;
}

/** Parses a scene sidecar's override, where `cutout` may be absent (the scene inherits the deck's shape and restyles the rest). */
export function parseFrameOverride(raw: unknown, source: string): FrameOverrideSpec | undefined {
  if (!isRecord(raw)) {
    console.warn(`[frame] ${source}: not an object — ignored`);
    return undefined;
  }
  const out: FrameOverrideSpec = {};
  if (raw.cutout !== undefined) {
    if (isRecord(raw.cutout) && SHAPES.includes(raw.cutout.shape as FrameShape)) {
      const cutoutRaw = raw.cutout;
      const cutout: FrameCutoutSpec = { shape: cutoutRaw.shape as FrameShape };
      const radius = num(cutoutRaw.radius);
      const size = num(cutoutRaw.size);
      const inset = num(cutoutRaw.inset);
      if (radius !== undefined) cutout.radius = radius;
      if (size !== undefined) cutout.size = size;
      if (inset !== undefined) cutout.inset = inset;
      if (SIDES.includes(cutoutRaw.side as FrameSide)) cutout.side = cutoutRaw.side as FrameSide;
      out.cutout = cutout;
    } else {
      console.warn(`[frame] ${source}: cutout needs a valid "shape" — dropped`);
    }
  }

  if (raw.enabled === false) out.enabled = false;
  if (raw.claimsSceneText === false) out.claimsSceneText = false;
  if (raw.background !== undefined) {
    if (isColour(raw.background)) out.background = raw.background;
    else console.warn(`[frame] ${source}: background isn't a theme token or hex — dropped`);
  }
  if (typeof raw.icon === "string" && raw.icon.length > 0) out.icon = raw.icon;
  if (TEXT_ALIGNS.includes(raw.textAlign as SceneTextAlign)) {
    out.textAlign = raw.textAlign as SceneTextAlign;
  }
  if (raw.chip !== undefined) {
    const chip = parseChip(raw.chip, source);
    if (chip) out.chip = chip;
  }
  if (raw.decorations !== undefined) {
    if (Array.isArray(raw.decorations)) {
      const decorations: FrameDecorationSpec[] = [];
      raw.decorations.forEach((entry, i) => {
        const decoration = parseDecoration(entry, source, i);
        if (decoration) decorations.push(decoration);
      });
      out.decorations = decorations;
    } else {
      console.warn(`[frame] ${source}: decorations isn't an array — dropped`);
    }
  }
  return out;
}

/** Merges a per-scene override over the deck default. A `cutout` present on the override replaces the deck's outright rather than merging field by field, so a scene picking a new shape never silently inherits a radius meant for another one; an absent `cutout` inherits the deck's. An override alone cannot make a frame, since with no deck default there is no shape to render through. */
export function mergeFrameSpec(
  base: FrameSpec | undefined,
  override: FrameOverrideSpec | undefined,
): FrameSpec | undefined {
  if (!override) return base;
  if (!base) return override.cutout ? (override as FrameSpec) : undefined;
  const merged: FrameSpec = { ...base, ...override, cutout: override.cutout ?? base.cutout };
  return merged;
}
