import type { TextLookSpec, Theme } from "../../theme/tokens";

/** Text-look presets (the style catalogue behind `theme.textLook` and the primitives' `look` prop), the styling twin of `presets.ts`: pure resolution over theme, sidecar and props, so preview and the deterministic export loop agree byte-for-byte. IMPORTANT (the null-for-legacy contract): when nothing is configured, `resolveTextLook` returns null and the renderer runs its original fill path verbatim, so committed projects must not change by a byte. */

export const TEXT_LOOK_NAMES = [
  "none",
  "gradient",
  "outline",
  "neon",
  "offset-print",
  "highlight-block",
  "frosted",
  "arc",
  "glass-3d",
  "chrome-3d",
] as const;
export type TextLookName = (typeof TEXT_LOOK_NAMES)[number];

export function isTextLookName(name: string): name is TextLookName {
  return (TEXT_LOOK_NAMES as readonly string[]).includes(name);
}

// ── Contract defaults (golden-pinned; changing any re-renders every project that uses the look pack) ──
/** gradient: axis in degrees (90 = vertical, colorA on top). */
export const DEFAULT_LOOK_ANGLE_DEG = 90;
/** outline: stroke width in em. */
export const DEFAULT_LOOK_STROKE_EM = 0.035;
/** outline: hollow by default, the iconic outline read (fill + stroke is the opt-out). */
export const DEFAULT_LOOK_HOLLOW = true;
/** neon/frosted/glass: strength scalar. */
export const DEFAULT_LOOK_INTENSITY = 0.6;
/** offset-print: under-layer displacement in em (down-right). */
export const DEFAULT_LOOK_OFFSET_EM = 0.06;
/** arc: total bend in degrees, positive arcs upward. */
export const DEFAULT_LOOK_CURVE_DEG = 60;

/** Clamp bounds, pinned beside the defaults (warn-once past them, the startScale pattern). */
const ANGLE_DEG_MIN = -360;
const ANGLE_DEG_MAX = 360;
const STROKE_EM_MIN = 0;
const STROKE_EM_MAX = 0.2;
const INTENSITY_MIN = 0;
const INTENSITY_MAX = 1;
const OFFSET_EM_MIN = -0.5;
const OFFSET_EM_MAX = 0.5;
const CURVE_DEG_MIN = -360;
const CURVE_DEG_MAX = 360;

const warnedLooks = new Set<string>();
function coerceLook(name: string | undefined, fallback: TextLookName): TextLookName {
  if (name === undefined) return fallback;
  if (isTextLookName(name)) return name;
  if (!warnedLooks.has(name)) {
    warnedLooks.add(name);
    console.warn(`[text] unknown text-look preset "${name}", using "none"`);
  }
  return "none";
}

const warnedParams = new Set<string>();
function clampParam(field: string, v: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, v));
  const key = `${field}:${v}`;
  if (clamped !== v && !warnedParams.has(key)) {
    warnedParams.add(key);
    console.warn(`[text] textLook.${field} ${v} out of range, clamped to ${clamped}`);
  }
  return clamped;
}

/** A fully resolved look: params always present and defaulted; colours stay optional so the renderer can fall back to the theme accent (colorA) and a darkened colorA (colorB). */
export interface ResolvedTextLook {
  preset: TextLookName;
  colorA?: string;
  colorB?: string;
  angleDeg: number;
  strokeEm: number;
  hollow: boolean;
  intensity: number;
  offsetEm: number;
  curveDeg: number;
}

/** The primitives' look props: `look` names the preset, the params ride the spec's field names. */
export type ResolveTextLookProps = { look?: string } & Partial<TextLookSpec>;

/** Merge primitive props over the sidecar's `textLook` (the whole-spec scene override, the textAnimation pattern) over the theme's default; returns null when NOTHING is configured, so the caller must then run the legacy fill path verbatim. */
export function resolveTextLook(
  props: ResolveTextLookProps,
  theme: Theme,
  docSpec?: TextLookSpec,
): ResolvedTextLook | null {
  const spec = docSpec ?? theme.textLook;
  const configured =
    props.look !== undefined ||
    props.preset !== undefined ||
    props.colorA !== undefined ||
    props.colorB !== undefined ||
    props.angleDeg !== undefined ||
    props.strokeEm !== undefined ||
    props.hollow !== undefined ||
    props.intensity !== undefined ||
    props.offsetEm !== undefined ||
    props.curveDeg !== undefined ||
    spec !== undefined;
  if (!configured) return null;

  const preset = coerceLook(props.look ?? props.preset ?? spec?.preset, "none");
  const colorA = props.colorA ?? spec?.colorA;
  const colorB = props.colorB ?? spec?.colorB;
  const rawAngle = props.angleDeg ?? spec?.angleDeg;
  const rawStroke = props.strokeEm ?? spec?.strokeEm;
  const rawIntensity = props.intensity ?? spec?.intensity;
  const rawOffset = props.offsetEm ?? spec?.offsetEm;
  const rawCurve = props.curveDeg ?? spec?.curveDeg;
  return {
    preset,
    ...(colorA !== undefined ? { colorA } : {}),
    ...(colorB !== undefined ? { colorB } : {}),
    angleDeg:
      rawAngle === undefined
        ? DEFAULT_LOOK_ANGLE_DEG
        : clampParam("angleDeg", rawAngle, ANGLE_DEG_MIN, ANGLE_DEG_MAX),
    strokeEm:
      rawStroke === undefined
        ? DEFAULT_LOOK_STROKE_EM
        : clampParam("strokeEm", rawStroke, STROKE_EM_MIN, STROKE_EM_MAX),
    hollow: props.hollow ?? spec?.hollow ?? DEFAULT_LOOK_HOLLOW,
    intensity:
      rawIntensity === undefined
        ? DEFAULT_LOOK_INTENSITY
        : clampParam("intensity", rawIntensity, INTENSITY_MIN, INTENSITY_MAX),
    offsetEm:
      rawOffset === undefined
        ? DEFAULT_LOOK_OFFSET_EM
        : clampParam("offsetEm", rawOffset, OFFSET_EM_MIN, OFFSET_EM_MAX),
    curveDeg:
      rawCurve === undefined
        ? DEFAULT_LOOK_CURVE_DEG
        : clampParam("curveDeg", rawCurve, CURVE_DEG_MIN, CURVE_DEG_MAX),
  };
}

/** The doc fields the force-aware resolver reads (a `SceneDoc` structural subset, typed here so the pure text layer never imports the engine schema). */
export interface TextLookDocFields {
  textLook?: TextLookSpec;
  textLookForce?: boolean;
  textLookOverrides?: Record<string, TextLookSpec>;
}

/** Sidecar-aware resolution: the shared resolver, honouring the doc's `textLookForce`; when set, the primitive's own TSX look props are IGNORED and the sidecar/theme spec drives. Absent flag = the normal prop-wins order. */
export function resolveTextLookWithDoc(
  props: ResolveTextLookProps,
  theme: Theme,
  doc: TextLookDocFields | null | undefined,
  textKey?: string,
): ResolvedTextLook | null {
  const force = doc?.textLookForce === true;
  const spec = (textKey ? doc?.textLookOverrides?.[textKey] : undefined) ?? doc?.textLook;
  return resolveTextLook(force ? {} : props, theme, spec);
}

/** SDF looks that need the v2 stagger material's look extension: gradient's block-bounds fragment mix, offset-print's under-layer draw, highlight-block's quad layer, frosted's softEm/weightEm/shine fields and arc's vertex bend. outline and neon ride plain troika material props (stroke, outlineBlur), so the block path keeps them. */
const SHADER_PATH_LOOKS: ReadonlySet<TextLookName> = new Set([
  "gradient",
  "offset-print",
  "highlight-block",
  "frosted",
  "arc",
]);

/** Whether the renderer must force the stagger shader path for this look; the 3D looks leave troika entirely, so they answer false here and true in `lookIs3d`. */
export function lookNeedsShaderPath(name: TextLookName): boolean {
  return SHADER_PATH_LOOKS.has(name);
}

/** Whether the look re-renders as extruded geometry (ExtrudedText) instead of troika SDF text. */
export function lookIs3d(name: TextLookName): boolean {
  return name === "glass-3d" || name === "chrome-3d";
}
