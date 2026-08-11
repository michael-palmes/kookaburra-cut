/** Validation for the overlay ("frame") block, in `project.json` as the deck default and in a scene sidecar as the per-scene override. Same degrade-don't-crash contract as `parseSceneDoc`: a malformed optional field drops with a warning, a malformed `cutout` drops the whole block, nothing throws. PURE module (validation only). See docs/overlays.md. */

import { parseGradient } from "../theme/schema";
import type {
  FrameChartPosition,
  FrameChartSlot,
  FrameChipSpec,
  FrameCutoutSpec,
  FrameDecorationFace,
  FrameDecorationLayer,
  FrameDecorationShape,
  FrameDecorationSpec,
  FrameOverrideSpec,
  FramePanelBackground,
  FrameShape,
  FrameSide,
  FrameSpec,
} from "../toolkit/frame/types";
import type { SceneTextAlign } from "./sceneDocSchema";

const SHAPES: FrameShape[] = ["rect", "rounded-rect", "squircle", "circle", "capsule", "none"];
const SIDES: FrameSide[] = ["start", "end"];
const DECORATION_SHAPES: FrameDecorationShape[] = ["none", "circle"];
const DECORATION_FACES: FrameDecorationFace[] = ["headline", "body"];
const CHART_POSITIONS: FrameChartPosition[] = ["below", "replace"];
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

/** The panel fill. A plain string stays a colour (the v1 shape every existing sidecar carries), an object picks one of the four fill types, and anything malformed drops the field so the panel falls back to the theme's neutral surface. */
function parsePanelBackground(
  raw: unknown,
  source: string,
): string | FramePanelBackground | undefined {
  if (typeof raw === "string") {
    if (isColour(raw)) return raw;
    console.warn(`[frame] ${source}: background isn't a theme token or hex, dropped`);
    return undefined;
  }
  if (!isRecord(raw)) {
    console.warn(`[frame] ${source}: background isn't a colour or a fill object, dropped`);
    return undefined;
  }
  switch (raw.type) {
    case "transparent":
      return { type: "transparent" };
    case "color":
      if (isColour(raw.color)) return { type: "color", color: raw.color };
      console.warn(`[frame] ${source}: background.color isn't a theme token or hex, dropped`);
      return undefined;
    case "gradient": {
      const gradient: Extract<FramePanelBackground, { type: "gradient" }> = { type: "gradient" };
      if (typeof raw.gradient === "string" && raw.gradient.length > 0) {
        gradient.gradient = raw.gradient;
      }
      if (raw.spec !== undefined) {
        const spec = parseGradient(raw.spec);
        if (spec) gradient.spec = spec;
        else console.warn(`[frame] ${source}: background.spec isn't a gradient, dropped`);
      }
      if (!gradient.gradient && !gradient.spec) {
        console.warn(`[frame] ${source}: background gradient needs a name or a spec, dropped`);
        return undefined;
      }
      return gradient;
    }
    case "image":
      if (typeof raw.src === "string" && raw.src.length > 0) return { type: "image", src: raw.src };
      console.warn(`[frame] ${source}: background.src needs an asset path, dropped`);
      return undefined;
    default:
      console.warn(
        `[frame] ${source}: background.type isn't transparent|color|gradient|image, dropped`,
      );
      return undefined;
  }
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

/** The panel's chart slot. `true` is the whole authoring surface for the common case (host the scene's panel chart on the defaults), `false` switches an inherited deck slot off, and the object form carries the two layout options. Sizes are NOT clamped here: absence stays legible and `framePanelChartSlot` owns the defaults and bounds. */
function parseChartSlot(raw: unknown, source: string): FrameChartSlot | undefined {
  if (raw === true) return {};
  if (raw === false) return { enabled: false };
  if (!isRecord(raw)) {
    console.warn(`[frame] ${source}: chart isn't a boolean or an object, dropped`);
    return undefined;
  }
  const slot: FrameChartSlot = {};
  if (raw.enabled === false) slot.enabled = false;
  const height = num(raw.height);
  if (height !== undefined) slot.height = height;
  else if (raw.height !== undefined) {
    console.warn(`[frame] ${source}: chart.height isn't a finite number, dropped`);
  }
  if (CHART_POSITIONS.includes(raw.position as FrameChartPosition)) {
    slot.position = raw.position as FrameChartPosition;
  } else if (raw.position !== undefined) {
    console.warn(`[frame] ${source}: chart.position isn't below|replace, dropped`);
  }
  return slot;
}

/** One decoration: an image (`src`) or a line of text (`text`), never both and never neither. */
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
  if (typeof raw.id !== "string") {
    console.warn(`[frame] ${source}: ${where} needs a string "id", dropped`);
    return undefined;
  }
  const src = typeof raw.src === "string" && raw.src.length > 0 ? raw.src : undefined;
  // An EMPTY text survives (the inspector's cleared field stays an editable text decoration); an empty src does not, since there is nothing to load.
  const text = typeof raw.text === "string" ? raw.text : undefined;
  if ((src === undefined) === (text === undefined)) {
    console.warn(`[frame] ${source}: ${where} needs exactly one of "src" or "text", dropped`);
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
    ...(src !== undefined ? { src } : { text }),
    position: [px, py],
    size,
  };
  if (text !== undefined) {
    if (raw.colour !== undefined) {
      if (isColour(raw.colour)) decoration.colour = raw.colour;
      else console.warn(`[frame] ${source}: ${where}.colour isn't a theme token or hex, dropped`);
    }
    if (DECORATION_FACES.includes(raw.face as FrameDecorationFace)) {
      decoration.face = raw.face as FrameDecorationFace;
    } else if (raw.face !== undefined) {
      console.warn(`[frame] ${source}: ${where}.face isn't headline|body, dropped`);
    }
    if (typeof raw.font === "string" && raw.font.length > 0) {
      decoration.font = raw.font;
    } else if (raw.font !== undefined) {
      console.warn(`[frame] ${source}: ${where}.font needs a font string, dropped`);
    }
    const lineHeight = num(raw.lineHeight);
    if (lineHeight !== undefined) {
      // The textStyle <key>LineHeight range, inlined (a value import of sceneDocSchema here would cycle).
      decoration.lineHeight = Math.min(2, Math.max(0.8, lineHeight));
    } else if (raw.lineHeight !== undefined) {
      console.warn(`[frame] ${source}: ${where}.lineHeight needs a finite number, dropped`);
    }
  }
  if (src !== undefined && DECORATION_SHAPES.includes(raw.shape as FrameDecorationShape)) {
    decoration.shape = raw.shape as FrameDecorationShape;
  }
  if (DECORATION_LAYERS.includes(raw.layer as FrameDecorationLayer)) {
    decoration.layer = raw.layer as FrameDecorationLayer;
  }
  const rotationDeg = num(raw.rotationDeg);
  if (rotationDeg !== undefined) {
    decoration.rotationDeg = rotationDeg;
  }
  const stackOrder = num(raw.stackOrder);
  if (stackOrder !== undefined) {
    decoration.stackOrder = stackOrder;
  } else if (raw.stackOrder !== undefined) {
    console.warn(`[frame] ${source}: ${where}.stackOrder needs a finite number, dropped`);
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
    const background = parsePanelBackground(raw.background, source);
    if (background !== undefined) out.background = background;
  }
  if (typeof raw.icon === "string") out.icon = raw.icon;
  if (TEXT_ALIGNS.includes(raw.textAlign as SceneTextAlign)) {
    out.textAlign = raw.textAlign as SceneTextAlign;
  }
  if (raw.chip !== undefined) {
    const chip = parseChip(raw.chip, source);
    if (chip) out.chip = chip;
  }
  if (raw.chart !== undefined) {
    const chart = parseChartSlot(raw.chart, source);
    if (chart) out.chart = chart;
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
