import { ease } from "../../engine/ease";
import type { TextAnimationSpec, Theme } from "../../theme/tokens";

/** Text-animation presets, the library behind `theme.textAnimation` and `AnimatedHeadline`'s `preset`/`ease`/`stagger` props: everything here is PURE math over the local scene clock so preview and the deterministic export loop agree byte-for-byte, and easing goes through the golden-tested `engine/ease` table, never an animation runtime. IMPORTANT (the null-for-legacy contract): when nothing is configured, `resolveTextAnimation` returns null and AnimatedHeadline runs its original v0 linear-ramp code verbatim, so committed projects on legacy themes must not change by a byte. */

export const TEXT_PRESET_NAMES = [
  "none",
  "fade",
  "fade-up",
  "blur-in",
  "slide",
  "mask-reveal",
  // The text motion pack.
  "fade-scale",
  "twist-scale",
  // Per-character 3D scatter entrance (Michael's reference round).
  "scatter-scale",
  // The wave-2 creative pack (motion-pack v2 per-unit fields).
  "tracking",
  "slam",
  "dolly",
  "chromatic",
  "line-stretch",
  "highlight-wipe",
  "rise-mask",
  "word-cycle",
  "ribbon",
  "stand-up",
  "spring-pop",
  "spotlight",
  "underline-draw",
  "orbit",
  "weight-build",
  "develop",
  "flip-cascade",
  "converge",
  "glint-wipe",
  "vapor",
] as const;
/** Inspector “None”: fully static, distinct from legacy `none`'s plain linear reveal. */
export const STATIC_TEXT_PRESET = "static" as const;
export type TextPresetName = (typeof TEXT_PRESET_NAMES)[number] | typeof STATIC_TEXT_PRESET;

export function isTextPresetName(name: string): name is TextPresetName {
  return name === STATIC_TEXT_PRESET || (TEXT_PRESET_NAMES as readonly string[]).includes(name);
}

export function textPresetHasMotion(name: TextPresetName): boolean {
  return name !== "none" && name !== STATIC_TEXT_PRESET;
}

/** The wave-2 pack, in TEXT_PRESET_NAMES order: every one samples v2 per-unit fields, per-unit hashing/slotting, companion quads or the accent shine tint, none of which the legacy block path carries. */
const SHADER_PATH_PRESETS: ReadonlySet<TextPresetName> = new Set([
  "tracking",
  "slam",
  "dolly",
  "chromatic",
  "line-stretch",
  "highlight-wipe",
  "rise-mask",
  "word-cycle",
  "ribbon",
  "stand-up",
  "spring-pop",
  "spotlight",
  "underline-draw",
  "orbit",
  "weight-build",
  "develop",
  "flip-cascade",
  "converge",
  "glint-wipe",
  "vapor",
]);

/** Whether the renderer must force the stagger shader path even at granularity null (mounting one whole-block unit); legacy presets stay on their original paths verbatim. */
export function presetNeedsShaderPath(name: TextPresetName): boolean {
  return SHADER_PATH_PRESETS.has(name);
}

/** Wave-2 forced default granularities (the scatter-scale precedent): applied only when nothing else chose, so no legacy input resolves differently. */
const FORCED_CHAR_PRESETS: ReadonlySet<TextPresetName> = new Set([
  "tracking",
  "orbit",
  "develop",
  "flip-cascade",
  "converge",
  "vapor",
]);
const FORCED_WORD_PRESETS: ReadonlySet<TextPresetName> = new Set([
  "dolly",
  "highlight-wipe",
  "rise-mask",
  "word-cycle",
  "ribbon",
  "stand-up",
  "spring-pop",
  "spotlight",
]);
function forcedGranularity(name: TextPresetName): StaggerGranularity | null {
  if (FORCED_CHAR_PRESETS.has(name)) return "char";
  if (FORCED_WORD_PRESETS.has(name)) return "word";
  return null;
}

/** Stagger granularities: words split on whitespace, chars are non-whitespace characters; paragraph granularities (spelled through `delivery`, never the public `stagger` prop) split on `\n` / blank lines and walk Y-key unit boundaries. */
export type StaggerGranularity = "char" | "word" | "paragraph" | "paragraph-group";

/** The unit-walk axis: layout X for char/word, −Y for the paragraph granularities (units are vertically disjoint contiguous line ranges by construction, the X-midpoint walk breaks on multiline units). */
export type StaggerAxis = "x" | "-y";

/** The two paragraph-capable delivery spellings. */
export type TextDelivery = "all-at-once" | "by-paragraph" | "by-paragraph-group";
export type TextDirection = "from-left" | "from-right";

/** Per-unit uniform arrays are fixed-size in the shader; longer texts merge into buckets. */
export const MAX_STAGGER_UNITS = 32;

/** Preset travel distances, in em (multiplied by fontSize at the primitive). */
const RISE_EM = 0.35;
const SLIDE_EM = 0.8;
/** Exported so the block path can normalise a blur sample back to halo opacity. */
export const BLUR_EM = 0.4;
/** Subtle scale pop used by blur-in (and its stagger fallback, which has no real blur). */
const POP_SCALE = 0.06;

// ── Contract constants (golden-pinned; changing any re-renders every project that uses the motion pack) ──────────────────────────────────────────────────────────
/** fade-scale's default starting scale (lands at 1; >1 settles down, <1 grows in). */
export const DEFAULT_START_SCALE = 0.8;
/** twist-scale's fixed entry angle around Y (a perspective card turn to rest). */
export const TWIST_RAD = Math.PI / 3;
/** twist-scale's fixed scale-in start. */
export const TWIST_START_SCALE = 0.92;
/** Shine band half-width as a fraction of the element's projected extent on the axis. */
export const SHINE_HALF_W = 0.18;
/** Additive white amount at the band's centre. */
export const SHINE_INTENSITY = 0.55;
/** The 45° sweep axis in layout space (x right, y up), unit length. */
export const SHINE_AXIS: readonly [number, number] = [Math.SQRT1_2, Math.SQRT1_2];

// ── scatter-scale contract constants (golden-pinned like the motion-pack set) ────────
/** Per-character counter-clockwise roll range at entry (unwinds to 0; Michael flipped the direction from the reference's clockwise on the 2026-07-09 eyeball). */
export const SCATTER_ROLL_MIN_RAD = (30 * Math.PI) / 180;
export const SCATTER_ROLL_MAX_RAD = (40 * Math.PI) / 180;
/** Entry z toward the camera, in em (perspective makes near glyphs huge + off-screen). */
export const SCATTER_DEPTH_EM = 6;
/** The whole-element counter-clockwise tilt whose per-unit arc offsets seed the X/Y drift (right end starts up-right, left end low-left, coherent with the roll; each unit unwinds its own share). */
export const SCATTER_TILT_RAD = (10 * Math.PI) / 180;
/** Fraction of each unit's travel spent fading in (the "short initial fade"). */
export const SCATTER_FADE_P = 0.25;
/** Per-unit duration multiplier range (different speeds per character). */
export const SCATTER_RATE_MIN = 0.7;

// ── Wave-2 contract constants (golden-pinned; unitHash01 salts: 0-2 scatter, 3 dolly depth, 4 develop order, 5 vapor phase, 6 vapor rate) ──────────────────────
/** tracking: fraction of each glyph's centre offset converged at entry. */
export const TRACK_TIGHTEN = 0.8;
/** tracking: per-glyph SDF soften at entry, em. */
export const TRACK_SOFT_EM = 0.18;
/** tracking: extra outward drift fraction on the out. */
export const TRACK_SPREAD = 0.35;
/** slam: entry scale, dropping to 1. */
export const SLAM_START_SCALE = 2.8;
/** slam: soft-focus depth at entry, em. */
export const SLAM_SOFT_EM = 0.3;
/** slam: fraction of the in spent fading in. */
export const SLAM_FADE_P = 0.4;
/** slam: landing compression depth (a closed-form sin bump, back to 1 at rest). */
export const SLAM_OVERSHOOT = 0.025;
/** slam: progress where the landing bump begins. */
export const SLAM_BUMP_START = 0.7;
/** slam: out scale-up target. */
export const SLAM_OUT_SCALE = 1.4;
/** dolly: entry depth behind the layout plane, em. */
export const DOLLY_EM = 3;
/** dolly: hashed per-word extra depth, em. */
export const DOLLY_JITTER_EM = 0.8;
/** dolly: soft-focus depth at entry, em. */
export const DOLLY_SOFT_EM = 0.2;
/** dolly: out travel past the camera, em. */
export const DOLLY_NEAR_EM = 2.5;
/** chromatic: entry R/B split, em. */
export const CHROMA_EM = 0.12;
/** line-stretch: the closed line's vertical and horizontal scales. */
export const LINE_SCALE_Y0 = 0.04;
export const LINE_SCALE_X0 = 0.65;
/** line-stretch: fraction of the in spent fading in. */
export const LINE_FADE_P = 0.5;
/** line-stretch: out progress where the collapsed line starts fading. */
export const LINE_OUT_FADE_P = 0.5;
/** rise-mask: rise distance, em. */
export const RISE_MASK_EM = 0.9;
/** rise-mask: fraction of the in spent fading in. */
export const RISE_MASK_FADE_P = 2 / 3;
/** rise-mask: out exit distance as a fraction of the entry rise. */
export const RISE_MASK_EXIT = 0.8;
/** rise-mask: out progress where the trailing fade starts. */
export const RISE_MASK_OUT_FADE_P = 0.5;
/** word-cycle: the pop scale each word enters from. */
export const WORD_CYCLE_POP_SCALE = 0.94;
/** word-cycle: fraction of a slot spent popping in (and out again). */
export const WORD_CYCLE_POP_P = 0.25;
/** ribbon: entry turn about Y, radians. */
export const RIBBON_RAD = (75 * Math.PI) / 180;
/** ribbon: toward-camera bow at mid-turn, em. */
export const RIBBON_BOW_EM = 0.4;
/** stand-up: entry tip from lying flat, radians. */
export const STAND_RAD = (88 * Math.PI) / 180;
/** stand-up: fraction of the in spent fading in. */
export const STAND_FADE_P = 0.35;
/** stand-up: tiny settle drop, em. */
export const STAND_SETTLE_EM = 0.06;
/** spring-pop: entry scale for the damped spring. */
export const SPRING_START_SCALE = 0.6;
/** spring-pop: damping (first overshoot lands ≈ 1.059). */
export const SPRING_DAMP = 4.8;
/** spring-pop: angular rate over p; 2.5π parks cos at 0 so rest is exactly 1. */
export const SPRING_FREQ = 2.5 * Math.PI;
/** spring-pop: fraction of the in spent fading in. */
export const SPRING_FADE_P = 0.3;
/** spring-pop: out anticipation bump height and window. */
export const SPRING_OUT_BUMP = 0.05;
export const SPRING_OUT_BUMP_P = 0.35;
/** spotlight: resting alpha for words outside the emphasis walk. */
export const SPOT_DIM = 0.35;
/** spotlight: scale lift at the walk's peak. */
export const SPOT_SCALE = 0.04;
/** underline-draw: fraction of the in the rule draws over. */
export const UNDERLINE_DRAW_P = 0.4;
/** underline-draw: in progress where the text ramp starts. */
export const UNDERLINE_TEXT_START_P = 0.3;
/** underline-draw: text entry rise, em. */
export const UNDERLINE_RISE_EM = 0.25;
/** underline-draw: fraction of the out the rule re-draws over. */
export const UNDERLINE_OUT_REDRAW_P = 0.4;
/** underline-draw: out progress where the rule's wipe-off begins. */
export const UNDERLINE_OUT_WIPE_P = 0.7;
/** underline-draw: fraction of the out the text sink-fade spans. */
export const UNDERLINE_OUT_TEXT_P = 0.7;
/** orbit: arc sweep about the block centre, radians (sign follows direction). */
export const ORBIT_SWEEP_RAD = (140 * Math.PI) / 180;
/** orbit: fraction of the in spent fading in. */
export const ORBIT_FADE_P = 0.25;
/** weight-build: the hairline start's SDF weight deficit, em. */
export const WEIGHT_EM = 0.045;
/** weight-build: fraction of the in spent fading in. */
export const WEIGHT_FADE_P = 0.3;
/** develop: entry SDF soften, em (reveal order hashes over the stagger budget). */
export const DEVELOP_SOFT_EM = 0.35;
/** flip-cascade: entry flip from face-down, radians. */
export const FLIP_RAD = Math.PI / 2;
/** flip-cascade: fraction of the in spent fading in. */
export const FLIP_FADE_P = 0.2;
/** flip-cascade: mid-flip dip, em. */
export const FLIP_DIP_EM = 0.08;
/** converge: entry offset toward the near screen edge, em. */
export const CONVERGE_EM = 8;
/** converge: peak streak stretch added to scaleX mid-travel. */
export const CONVERGE_STREAK = 1.4;
/** converge: fraction of the in spent fading in. */
export const CONVERGE_FADE_P = 0.2;
/** glint-wipe: the accent leading edge, tighter and brighter than the soft shine (the material writer keys these off the preset name). */
export const GLINT_HALF_W = 0.06;
export const GLINT_INTENSITY = 0.85;
/** vapor: rise, wobble amplitude and soften, em. */
export const VAPOR_RISE_EM = 1.2;
export const VAPOR_WOBBLE_EM = 0.15;
export const VAPOR_SOFT_EM = 0.5;
/** vapor: per-char duration multiplier floor (slight hashed rate jitter). */
export const VAPOR_RATE_MIN = 0.85;

/** Deterministic per-unit randomness: a pure integer avalanche hash → [0, 1), never Math.random (same unit, same salt, same value forever, the seeded `engine/rng`/PCG-glitch precedent). Golden-pinned. */
export function unitHash01(index: number, salt: number): number {
  let h = (Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Default per-unit delays when a scene asks for stagger without giving `staggerMs`. */
const DEFAULT_STAGGER_MS: Record<StaggerGranularity, number> = {
  char: 35,
  word: 90,
  paragraph: 160,
  "paragraph-group": 260,
};

/** Per-preset params, always present, fully defaulted at resolve. */
export interface TextPresetParams {
  /** fade-scale: the starting scale, landing at 1 (0.8 grows in; 1.15 settles down). */
  startScale: number;
  /** twist-scale: an explicitly authored starting scale; absent preserves the tuned legacy 0.92. */
  twistStartScale?: number;
  /** fade-scale and twist-scale: sweep the soft white shine band once, during the scale-in only. */
  shine: boolean;
  /** twist-scale and orbit (the sweep sign): +1 = from-left, −1 = from-right. */
  twistDir: 1 | -1;
}

/** A fully resolved animation: what to play, how to ease it, and how to stagger it. */
export interface ResolvedTextAnimation {
  preset: TextPresetName;
  outPreset: TextPresetName;
  /** An `engine/ease` name; unknown names degrade inside `ease()` itself. */
  ease: string;
  staggerMs: number;
  /** null = whole-block (no stagger). */
  granularity: StaggerGranularity | null;
  /** Hold before the in starts, ms; present only when > 0 (0 and absent are identical). The out never shifts. */
  delayMs?: number;
  /** Absent keeps the primitive's authored `from` → `to` window. */
  durationMs?: number;
  /** Absent keeps the selected preset's tuned travel distance. */
  distance?: number;
  params: TextPresetParams;
}

export interface ResolveTextAnimationProps {
  preset?: string;
  outPreset?: string;
  ease?: string;
  stagger?: StaggerGranularity;
  staggerMs?: number;
  delayMs?: number;
  startScale?: number;
  shine?: boolean;
  direction?: string;
  delivery?: string;
}

const warnedPresets = new Set<string>();
function coercePreset(name: string | undefined, fallback: TextPresetName): TextPresetName {
  if (name === undefined) return fallback;
  if (isTextPresetName(name)) return name;
  if (!warnedPresets.has(name)) {
    warnedPresets.add(name);
    console.warn(`[text] unknown text-animation preset "${name}" — using "fade"`);
  }
  return "fade";
}

const warnedScales = new Set<number>();
function clampStartScale(v: number): number {
  const clamped = Math.min(4, Math.max(0.05, v));
  if (clamped !== v && !warnedScales.has(v)) {
    warnedScales.add(v);
    console.warn(`[text] startScale ${v} out of range — clamped to ${clamped}`);
  }
  return clamped;
}

const warnedDelays = new Set<number>();
function clampDelayMs(v: number): number {
  const clamped = Number.isFinite(v) ? Math.max(0, v) : 0;
  if (clamped !== v && !warnedDelays.has(v)) {
    warnedDelays.add(v);
    console.warn(`[text] delayMs ${v} out of range, clamped to ${clamped}`);
  }
  return clamped;
}

/** `delivery` maps onto the stagger machinery; all-at-once FORCES the block path. */
function deliveryGranularity(delivery: string): StaggerGranularity | null | undefined {
  switch (delivery) {
    case "all-at-once":
      return null;
    case "by-paragraph":
      return "paragraph";
    case "by-paragraph-group":
      return "paragraph-group";
    default:
      return undefined; // unknown spelling, fall through to the next resolution step
  }
}

/** Merge primitive props over the sidecar's `textAnimation` (the whole-spec scene override, the backdrop pattern) over the theme's defaults; returns null when NOTHING is configured, so the caller must then run the legacy v0 ramp verbatim. */
export function resolveTextAnimation(
  props: ResolveTextAnimationProps,
  theme: Theme,
  docSpec?: TextAnimationSpec,
): ResolvedTextAnimation | null {
  const spec = docSpec ?? theme.textAnimation;
  const configured =
    props.preset !== undefined ||
    props.outPreset !== undefined ||
    props.ease !== undefined ||
    props.stagger !== undefined ||
    props.staggerMs !== undefined ||
    props.delayMs !== undefined ||
    props.startScale !== undefined ||
    props.shine !== undefined ||
    props.direction !== undefined ||
    props.delivery !== undefined ||
    spec !== undefined;
  if (!configured) return null;

  const preset = coercePreset(props.preset ?? spec?.in, "fade");
  const outPreset = coercePreset(props.outPreset ?? spec?.out, "none");
  let staggerMs = Math.max(0, props.staggerMs ?? spec?.staggerMs ?? 0);
  // Granularity precedence: props.stagger > props.delivery > theme/doc stagger > theme/doc delivery > the staggerMs-implied "word" default; legacy inputs resolve exactly as before (the null-for-legacy contract's cousin).
  const propDelivery =
    props.delivery !== undefined ? deliveryGranularity(props.delivery) : undefined;
  const specDelivery =
    spec?.delivery !== undefined ? deliveryGranularity(spec.delivery) : undefined;
  let granularity: StaggerGranularity | null;
  if (props.stagger !== undefined) granularity = props.stagger;
  else if (propDelivery !== undefined) granularity = propDelivery;
  else if (staggerMs > 0 && preset !== "none" && spec?.stagger !== undefined) {
    granularity = spec.stagger;
  } else if (specDelivery !== undefined) granularity = specDelivery;
  // scatter-scale is inherently per-character; when nothing else chose, default to char (a new preset name, so no legacy input can reach this branch differently).
  else if (preset === "scatter-scale") granularity = "char";
  // Wave-2 forced defaults; the out is consulted too (vapor is designed as an out), still unreachable by legacy inputs.
  else if (forcedGranularity(preset) ?? forcedGranularity(outPreset)) {
    granularity = forcedGranularity(preset) ?? forcedGranularity(outPreset);
  } else granularity = staggerMs > 0 && preset !== "none" && preset !== "static" ? "word" : null;
  // A granularity request without any delay configured gets the granularity's default, unless the scene explicitly passed staggerMs={0}, which wins.
  if (granularity && staggerMs === 0 && props.staggerMs === undefined) {
    staggerMs = DEFAULT_STAGGER_MS[granularity];
  }
  const rawStart = props.startScale ?? spec?.startScale;
  const direction = props.direction ?? spec?.direction;
  const rawDelay = props.delayMs ?? spec?.delayMs;
  const delayMs = rawDelay === undefined ? undefined : clampDelayMs(rawDelay);
  return {
    preset,
    outPreset,
    ease: props.ease ?? spec?.ease ?? theme.motion.easings.standard,
    staggerMs,
    granularity: preset === "none" || preset === "static" ? null : granularity,
    // 0 resolves to absent, so a written-then-zeroed delay stays byte-identical to never-set.
    ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
    ...(spec?.durationMs !== undefined ? { durationMs: spec.durationMs } : {}),
    ...(spec?.distance !== undefined ? { distance: spec.distance } : {}),
    params: {
      startScale: rawStart === undefined ? DEFAULT_START_SCALE : clampStartScale(rawStart),
      ...(rawStart !== undefined && (preset === "twist-scale" || outPreset === "twist-scale")
        ? { twistStartScale: clampStartScale(rawStart) }
        : {}),
      shine: props.shine ?? spec?.shine ?? false,
      twistDir: direction === "from-right" ? -1 : 1,
    },
  };
}

/** The doc fields the force-aware resolver reads (a `SceneDoc` structural subset, typed here so the pure text layer never imports the engine schema). */
export interface TextAnimationDocFields {
  textAnimation?: TextAnimationSpec;
  textAnimationForce?: boolean;
  textAnimationOverrides?: Record<string, TextAnimationSpec>;
}

/** Sidecar-aware resolution: the shared resolver, honouring the doc's `textAnimationForce`; when set, the primitive's own TSX animation props are IGNORED and the sidecar/theme spec drives (the app's "Override coded motion"; timing props like from/to/outAt are not animation props and keep applying). Absent flag = the normal prop-wins order. */
export function resolveTextAnimationWithDoc(
  props: ResolveTextAnimationProps,
  theme: Theme,
  doc: TextAnimationDocFields | null | undefined,
  textKey?: string,
): ResolvedTextAnimation | null {
  const force = doc?.textAnimationForce === true;
  const spec = (textKey ? doc?.textAnimationOverrides?.[textKey] : undefined) ?? doc?.textAnimation;
  return resolveTextAnimation(force ? {} : props, theme, spec);
}

/** The in window's duration reference (what `TextAnimTiming.to` carries): the authored end unless durationMs overrides it. A resolved delayMs is NOT included, `sampleTextUnit` shifts the start itself. */
export function textAnimationWindowToMs(
  from: number,
  authoredTo: number,
  anim: ResolvedTextAnimation,
): number {
  return anim.durationMs === undefined ? authoredTo : from + anim.durationMs;
}

/** The effective end of a preset's in: the window end shifted by any resolved delayMs (the in genuinely lands that much later). Absent duration and delay return the authored value exactly. */
export function textAnimationEndMs(
  from: number,
  authoredTo: number,
  anim: ResolvedTextAnimation,
): number {
  const end = textAnimationWindowToMs(from, authoredTo, anim);
  return anim.delayMs === undefined ? end : end + anim.delayMs;
}

/** Whether a primitive's props configure its own animation, exactly the resolver's props-only "configured" test (what the coded-motion registry reports). */
export function hasOwnAnimationProps(props: ResolveTextAnimationProps): boolean {
  return (
    props.preset !== undefined ||
    props.outPreset !== undefined ||
    props.ease !== undefined ||
    props.stagger !== undefined ||
    props.staggerMs !== undefined ||
    props.delayMs !== undefined ||
    props.startScale !== undefined ||
    props.shine !== undefined ||
    props.direction !== undefined ||
    props.delivery !== undefined
  );
}

/** Float32-safe "past every glyph" sentinel for the last unit's decision edge. */
export const EDGE_SENTINEL = 1e30;

/** The animation window: `from`→`to` plays the in preset (a resolved delayMs holds the pre-entry state that long after `from`, then the in plays over the same `to − from` duration); `outAt` (optional) starts the out and never shifts. */
export interface TextAnimTiming {
  anim: ResolvedTextAnimation;
  from: number;
  to: number;
  /** Out start, ms; the out plays over the same duration as the in. Absent = no out. */
  outAt?: number;
}

/** One unit's sampled state: offsets/blur are in em, sweep is a [left, right] 0..1 window; the motion-pack fields carry NEUTRAL defaults (0 / −1 off-sentinel) so every legacy preset case ships verbatim. */
export interface TextUnitSample {
  alpha: number;
  dxEm: number;
  dyEm: number;
  scale: number;
  blurEm: number;
  sweep: readonly [number, number];
  /** twist-scale: Y rotation, radians (0 for every other preset). */
  rotYRad: number;
  /** fade-scale shine: eased 0..1 band progress; −1 = shine off. */
  shineU: number;
  /** scatter-scale: in-plane roll about the glyph centre, radians (0 elsewhere; negative = clockwise on screen). */
  rotZRad: number;
  /** scatter-scale: z offset toward the camera, in em (0 elsewhere). */
  dzEm: number;
  // ── Motion-pack v2 per-unit fields, all NEUTRAL defaults so legacy presets ship verbatim ──
  /** Rotation about the unit's X axis, radians (positive tips the top away from camera). */
  rotXRad: number;
  /** Anisotropic scale multipliers, composed with `scale`. */
  scaleX: number;
  scaleY: number;
  /** Hard-clip the unit to its FINAL layout bounds while it moves (rise-mask's baseline mask). */
  clipFinal: boolean;
  /** 0 = base fill, 1 = accent colour (spotlight's walking emphasis). */
  colorMix: number;
  /** SDF weight offset in em (+ bolder, − thinner; weight-build's fake variable font). */
  weightEm: number;
  /** Per-unit SDF edge soften in em (develop/vapor; distinct from the block outlineBlur halo). */
  softEm: number;
  /** Chromatic split offset in em (drives the tinted R/B echo layers; 0 = off). */
  chromaEm: number;
  /** Accent highlight block coverage over the unit, [left, right] 0..1 ([0, 0] = no block). */
  highlight: readonly [number, number];
}

/** Optional per-unit geometry for sampling: `count` spreads scatter/develop's hashed delays over the real unit count and slots word-cycle/spotlight's walks; `unitCenterEm` (em, relative to the ELEMENT centre) seeds the scatter tilt drift and tracking/orbit/converge/word-cycle's centre-relative moves; absent = one whole-block unit. */
export interface ScatterSampleContext {
  count: number;
  unitCenterEm?: readonly [number, number];
}

const FULL_SWEEP: readonly [number, number] = [0, 1];
const HIGHLIGHT_OFF: readonly [number, number] = [0, 0];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** highlight-wipe at progress `t`: the accent block grows over the word (phase 1), then its left edge chases right, revealing text where it has passed (phase 2). */
function highlightWipeAt(t: number): { l: number; r: number; reveal: number } {
  if (t >= 1) return { l: 0, r: 0, reveal: 1 };
  if (t < 0.5) return { l: 0, r: 2 * t, reveal: 0 };
  return { l: 2 * t - 1, r: 1, reveal: 2 * t - 1 };
}

/** Sample unit `unitIndex` at local scene time `localMs`: unit i's window is the block's window shifted by `i × staggerMs` (each unit keeps the full in duration, so the last unit finishes `(units−1) × staggerMs` after `to`); a resolved delayMs shifts every in window (composing additively with the stagger) while the out stays on `outAt`; scatter-scale replaces the ordered delay with a hashed one spread over the same budget and jitters each unit's duration (develop hashes only the delay, vapor only the duration), pure functions of the unit index, so preview and export agree. */
export function sampleTextUnit(
  timing: TextAnimTiming,
  unitIndex: number,
  localMs: number,
  ctx?: ScatterSampleContext,
): TextUnitSample {
  const { anim, to, outAt } = timing;
  const durationMs = Math.max(1, to - timing.from);
  // delayMs holds the pre-entry state: the in start shifts, the out (outAt) never does.
  const from = anim.delayMs === undefined ? timing.from : timing.from + anim.delayMs;
  const scattering = anim.preset === "scatter-scale" || anim.outPreset === "scatter-scale";
  let delay = unitIndex * anim.staggerMs;
  let unitDurationMs = durationMs;
  if (scattering) {
    const spread = Math.max(0, (ctx?.count ?? 1) - 1) * anim.staggerMs;
    delay = unitHash01(unitIndex, 0) * spread;
    unitDurationMs =
      durationMs * (SCATTER_RATE_MIN + (1 - SCATTER_RATE_MIN) * unitHash01(unitIndex, 1));
  } else if (anim.preset === "develop" || anim.outPreset === "develop") {
    delay = unitHash01(unitIndex, 4) * Math.max(0, (ctx?.count ?? 1) - 1) * anim.staggerMs;
  } else if (anim.preset === "vapor" || anim.outPreset === "vapor") {
    unitDurationMs =
      durationMs * (VAPOR_RATE_MIN + (1 - VAPOR_RATE_MIN) * unitHash01(unitIndex, 6));
  }
  const p = ease(anim.ease, clamp01((localMs - from - delay) / unitDurationMs));
  const q =
    outAt === undefined ? 0 : ease(anim.ease, clamp01((localMs - outAt - delay) / unitDurationMs));

  let alpha = 1;
  let dxEm = 0;
  let dyEm = 0;
  let scale = 1;
  let blurEm = 0;
  let sweepL = 0;
  let sweepR = 1;
  let rotYRad = 0;
  let shineU = -1;
  let rotZRad = 0;
  let dzEm = 0;
  let rotXRad = 0;
  let scaleX = 1;
  let scaleY = 1;
  let clipFinal = false;
  let colorMix = 0;
  let weightEm = 0;
  let softEm = 0;
  let chromaEm = 0;
  let highlightL = 0;
  let highlightR = 0;
  // word-cycle centres the active word once, whichever of the in/out claimed it.
  let cycleCentered = false;

  switch (anim.preset) {
    case "none":
    case "static":
      break;
    case "fade":
      alpha = p;
      break;
    case "fade-up":
      alpha = p;
      dyEm = -(1 - p) * (anim.distance ?? RISE_EM);
      break;
    case "blur-in":
      alpha = p;
      blurEm = (1 - p) * BLUR_EM;
      scale = 1 + (1 - p) * POP_SCALE;
      break;
    case "slide":
      alpha = p;
      dxEm = -(1 - p) * (anim.distance ?? SLIDE_EM);
      break;
    case "mask-reveal":
      sweepR = p;
      break;
    case "fade-scale": {
      alpha = p;
      const s0 = anim.params.startScale;
      scale = s0 + (1 - s0) * p;
      // Shine sweeps ONCE, during the scale-in only: past the in window p clamps at 1 and the band is parked fully off-element, so the out needs no special-casing.
      if (anim.params.shine) shineU = p;
      break;
    }
    case "twist-scale": {
      const s0 = anim.params.twistStartScale ?? TWIST_START_SCALE;
      alpha = p;
      scale = s0 + (1 - s0) * p;
      rotYRad = anim.params.twistDir * (1 - p) * TWIST_RAD;
      if (anim.params.shine) shineU = p;
      break;
    }
    case "scatter-scale": {
      const settle = 1 - p;
      alpha = clamp01(p / SCATTER_FADE_P);
      rotZRad =
        (SCATTER_ROLL_MIN_RAD +
          (SCATTER_ROLL_MAX_RAD - SCATTER_ROLL_MIN_RAD) * unitHash01(unitIndex, 2)) *
        settle;
      const travel = anim.distance ?? SCATTER_DEPTH_EM;
      dzEm = travel * settle;
      if (ctx?.unitCenterEm) {
        // The unit's share of the element tilt: rotate its centre counter-clockwise by θ = TILT × settle about the element centre; the drift is the arc offset.
        const theta = SCATTER_TILT_RAD * (travel / SCATTER_DEPTH_EM) * settle;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const [cx, cy] = ctx.unitCenterEm;
        dxEm += cx * (cos - 1) - cy * sin;
        dyEm += cx * sin + cy * (cos - 1);
      }
      break;
    }
    case "tracking": {
      const settle = 1 - p;
      alpha = p;
      softEm = TRACK_SOFT_EM * settle;
      if (ctx?.unitCenterEm) dxEm -= ctx.unitCenterEm[0] * TRACK_TIGHTEN * settle;
      break;
    }
    case "slam": {
      const settle = 1 - p;
      alpha = clamp01(p / SLAM_FADE_P);
      softEm = SLAM_SOFT_EM * settle;
      const land = Math.sin(Math.PI * clamp01((p - SLAM_BUMP_START) / (1 - SLAM_BUMP_START)));
      scale = 1 + (SLAM_START_SCALE - 1) * settle - SLAM_OVERSHOOT * land;
      break;
    }
    case "dolly": {
      const settle = 1 - p;
      alpha = p;
      softEm = DOLLY_SOFT_EM * settle;
      dzEm = -(DOLLY_EM + DOLLY_JITTER_EM * unitHash01(unitIndex, 3)) * settle;
      break;
    }
    case "chromatic":
      alpha = p;
      chromaEm = CHROMA_EM * (1 - p);
      break;
    case "line-stretch": {
      const settle = 1 - p;
      alpha = clamp01(p / LINE_FADE_P);
      scaleY = 1 - (1 - LINE_SCALE_Y0) * settle;
      scaleX = 1 - (1 - LINE_SCALE_X0) * settle;
      shineU = p;
      break;
    }
    case "highlight-wipe": {
      const w = highlightWipeAt(p);
      highlightL = w.l;
      highlightR = w.r;
      sweepR = w.reveal;
      break;
    }
    case "rise-mask":
      alpha = clamp01(p / RISE_MASK_FADE_P);
      dyEm = -RISE_MASK_EM * (1 - p);
      clipFinal = p < 1;
      break;
    case "word-cycle": {
      const count = Math.max(1, ctx?.count ?? 1);
      const bp = clamp01((localMs - from) / durationMs);
      const slot = Math.min(count - 1, Math.floor(bp * count));
      if (slot !== unitIndex) {
        alpha = 0;
        break;
      }
      const sp = clamp01(bp * count - unitIndex);
      const enter = ease(anim.ease, clamp01(sp / WORD_CYCLE_POP_P));
      const exit =
        unitIndex === count - 1
          ? 0
          : ease(anim.ease, clamp01((sp - (1 - WORD_CYCLE_POP_P)) / WORD_CYCLE_POP_P));
      alpha = enter * (1 - exit);
      scale =
        (1 - (1 - WORD_CYCLE_POP_SCALE) * (1 - enter)) * (1 - (1 - WORD_CYCLE_POP_SCALE) * exit);
      cycleCentered = true;
      break;
    }
    case "ribbon": {
      const settle = 1 - p;
      alpha = p;
      rotYRad = RIBBON_RAD * settle;
      dzEm = RIBBON_BOW_EM * Math.sin(Math.PI * p);
      break;
    }
    case "stand-up": {
      const settle = 1 - p;
      alpha = clamp01(p / STAND_FADE_P);
      rotXRad = -STAND_RAD * settle;
      dyEm = -STAND_SETTLE_EM * settle;
      break;
    }
    case "spring-pop":
      alpha = clamp01(p / SPRING_FADE_P);
      scale = 1 + (SPRING_START_SCALE - 1) * Math.exp(-SPRING_DAMP * p) * Math.cos(SPRING_FREQ * p);
      break;
    case "spotlight": {
      const count = Math.max(1, ctx?.count ?? 1);
      const t = clamp01((localMs - from) / durationMs) * count - unitIndex;
      const w = clamp01(1 - Math.abs(2 * t - 1));
      const emphasis = w * w * (3 - 2 * w);
      alpha = SPOT_DIM + (1 - SPOT_DIM) * (t >= 0.5 ? 1 : emphasis);
      colorMix = emphasis;
      scale = 1 + SPOT_SCALE * emphasis;
      break;
    }
    case "underline-draw": {
      const u = clamp01((p - UNDERLINE_TEXT_START_P) / (1 - UNDERLINE_TEXT_START_P));
      alpha = u;
      dyEm = -UNDERLINE_RISE_EM * (1 - u);
      break;
    }
    case "orbit": {
      const theta = anim.params.twistDir * ORBIT_SWEEP_RAD * (1 - p);
      alpha = clamp01(p / ORBIT_FADE_P);
      rotZRad = theta;
      if (ctx?.unitCenterEm) {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const [cx, cy] = ctx.unitCenterEm;
        dxEm += cx * (cos - 1) - cy * sin;
        dyEm += cx * sin + cy * (cos - 1);
      }
      break;
    }
    case "weight-build":
      alpha = clamp01(p / WEIGHT_FADE_P);
      weightEm = -WEIGHT_EM * (1 - p);
      break;
    case "develop":
      alpha = p;
      softEm = DEVELOP_SOFT_EM * (1 - p);
      break;
    case "flip-cascade":
      alpha = clamp01(p / FLIP_FADE_P);
      rotXRad = FLIP_RAD * (1 - p);
      dyEm -= FLIP_DIP_EM * Math.sin(Math.PI * p);
      break;
    case "converge": {
      const settle = 1 - p;
      alpha = clamp01(p / CONVERGE_FADE_P);
      scaleX = 1 + CONVERGE_STREAK * settle * (1 - settle) * 4;
      if (ctx?.unitCenterEm) dxEm += Math.sign(ctx.unitCenterEm[0]) * CONVERGE_EM * settle;
      break;
    }
    case "glint-wipe":
      sweepR = p;
      shineU = p;
      break;
    case "vapor": {
      const settle = 1 - p;
      const phase = unitHash01(unitIndex, 5) * 2 * Math.PI;
      alpha = p;
      dyEm += VAPOR_RISE_EM * settle;
      dxEm += Math.sin(settle * 2 * Math.PI + phase) * VAPOR_WOBBLE_EM * settle;
      softEm = VAPOR_SOFT_EM * settle;
      break;
    }
  }

  if (q > 0) {
    switch (anim.outPreset) {
      case "none":
      case "static":
        break;
      case "fade":
        alpha *= 1 - q;
        break;
      case "fade-up":
        alpha *= 1 - q;
        dyEm += q * (anim.distance ?? RISE_EM);
        break;
      case "blur-in":
        alpha *= 1 - q;
        blurEm += q * BLUR_EM;
        scale *= 1 + q * POP_SCALE;
        break;
      case "slide":
        alpha *= 1 - q;
        dxEm += q * (anim.distance ?? SLIDE_EM);
        break;
      case "mask-reveal":
        sweepL = q;
        break;
      // Outs: multiplicative mirrors (the blur-in precedent, they compose on overlapping windows), easing back toward the entry state.
      case "fade-scale": {
        alpha *= 1 - q;
        const s0 = anim.params.startScale;
        scale *= s0 + (1 - s0) * (1 - q);
        break;
      }
      case "twist-scale": {
        const s0 = anim.params.twistStartScale ?? TWIST_START_SCALE;
        alpha *= 1 - q;
        scale *= s0 + (1 - s0) * (1 - q);
        rotYRad += anim.params.twistDir * q * TWIST_RAD;
        break;
      }
      case "scatter-scale": {
        const travel = anim.distance ?? SCATTER_DEPTH_EM;
        alpha *= 1 - q;
        rotZRad +=
          (SCATTER_ROLL_MIN_RAD +
            (SCATTER_ROLL_MAX_RAD - SCATTER_ROLL_MIN_RAD) * unitHash01(unitIndex, 2)) *
          q;
        dzEm += travel * q;
        if (ctx?.unitCenterEm) {
          const theta = SCATTER_TILT_RAD * (travel / SCATTER_DEPTH_EM) * q;
          const cos = Math.cos(theta);
          const sin = Math.sin(theta);
          const [cx, cy] = ctx.unitCenterEm;
          dxEm += cx * (cos - 1) - cy * sin;
          dyEm += cx * sin + cy * (cos - 1);
        }
        break;
      }
      case "tracking": {
        alpha *= 1 - q;
        softEm += TRACK_SOFT_EM * q;
        if (ctx?.unitCenterEm) dxEm += ctx.unitCenterEm[0] * TRACK_SPREAD * q;
        break;
      }
      case "slam":
        alpha *= 1 - q;
        softEm += SLAM_SOFT_EM * q;
        scale *= 1 + (SLAM_OUT_SCALE - 1) * q;
        break;
      case "dolly":
        alpha *= 1 - q;
        softEm += DOLLY_SOFT_EM * q;
        dzEm += DOLLY_NEAR_EM * q;
        break;
      case "chromatic":
        alpha *= 1 - q;
        chromaEm += CHROMA_EM * q;
        break;
      case "line-stretch":
        scaleY *= 1 - (1 - LINE_SCALE_Y0) * q;
        scaleX *= 1 - (1 - LINE_SCALE_X0) * q;
        alpha *= 1 - clamp01((q - LINE_OUT_FADE_P) / (1 - LINE_OUT_FADE_P));
        break;
      // The block returns, collects the word, then sweeps off: the in replayed at 1 − q.
      case "highlight-wipe": {
        const w = highlightWipeAt(1 - q);
        highlightL = w.l;
        highlightR = w.r;
        sweepR = Math.min(sweepR, w.reveal);
        break;
      }
      case "rise-mask":
        dyEm += RISE_MASK_EM * RISE_MASK_EXIT * q;
        clipFinal = true;
        alpha *= 1 - clamp01((q - RISE_MASK_OUT_FADE_P) / (1 - RISE_MASK_OUT_FADE_P));
        break;
      // The in's slot walk rewound; alpha is assigned (the in already zeroed passed words).
      case "word-cycle": {
        const count = Math.max(1, ctx?.count ?? 1);
        const t = 1 - clamp01((localMs - (outAt ?? 0)) / durationMs);
        const slot = Math.min(count - 1, Math.floor(t * count));
        if (slot !== unitIndex) {
          alpha = 0;
          break;
        }
        const sp = clamp01(t * count - unitIndex);
        const enter = ease(anim.ease, clamp01(sp / WORD_CYCLE_POP_P));
        const exit =
          unitIndex === count - 1
            ? 0
            : ease(anim.ease, clamp01((sp - (1 - WORD_CYCLE_POP_P)) / WORD_CYCLE_POP_P));
        alpha = enter * (1 - exit);
        scale *=
          (1 - (1 - WORD_CYCLE_POP_SCALE) * (1 - enter)) * (1 - (1 - WORD_CYCLE_POP_SCALE) * exit);
        cycleCentered = true;
        break;
      }
      case "ribbon":
        alpha *= 1 - q;
        rotYRad -= RIBBON_RAD * q;
        dzEm += RIBBON_BOW_EM * Math.sin(Math.PI * q);
        break;
      case "stand-up":
        alpha *= 1 - q;
        rotXRad += STAND_RAD * q;
        break;
      case "spring-pop": {
        alpha *= 1 - q;
        const bump = SPRING_OUT_BUMP * Math.sin(Math.PI * clamp01(q / SPRING_OUT_BUMP_P));
        scale *= (1 + bump) * (1 + (SPRING_START_SCALE - 1) * q);
        break;
      }
      case "spotlight":
        alpha *= 1 - q;
        break;
      case "underline-draw": {
        const v = clamp01(q / UNDERLINE_OUT_TEXT_P);
        alpha *= 1 - v;
        dyEm -= UNDERLINE_RISE_EM * v;
        break;
      }
      case "orbit": {
        const theta = -anim.params.twistDir * ORBIT_SWEEP_RAD * q;
        alpha *= 1 - q;
        rotZRad += theta;
        if (ctx?.unitCenterEm) {
          const cos = Math.cos(theta);
          const sin = Math.sin(theta);
          const [cx, cy] = ctx.unitCenterEm;
          dxEm += cx * (cos - 1) - cy * sin;
          dyEm += cx * sin + cy * (cos - 1);
        }
        break;
      }
      case "weight-build":
        alpha *= 1 - q;
        weightEm -= WEIGHT_EM * q;
        break;
      case "develop":
        alpha *= 1 - q;
        softEm += DEVELOP_SOFT_EM * q;
        break;
      case "flip-cascade":
        alpha *= 1 - q;
        rotXRad -= FLIP_RAD * q;
        dyEm -= FLIP_DIP_EM * Math.sin(Math.PI * q);
        break;
      case "converge":
        alpha *= 1 - q;
        scaleX *= 1 + CONVERGE_STREAK * q * (1 - q) * 4;
        if (ctx?.unitCenterEm) dxEm += Math.sign(ctx.unitCenterEm[0]) * CONVERGE_EM * q;
        break;
      case "glint-wipe":
        sweepL = q;
        shineU = q;
        break;
      case "vapor": {
        const phase = unitHash01(unitIndex, 5) * 2 * Math.PI;
        alpha *= 1 - q;
        dyEm += VAPOR_RISE_EM * q;
        dxEm += Math.sin(q * 2 * Math.PI + phase) * VAPOR_WOBBLE_EM * q;
        softEm += VAPOR_SOFT_EM * q;
        break;
      }
    }
  }
  if (cycleCentered && ctx?.unitCenterEm) dxEm -= ctx.unitCenterEm[0];

  const sweep: readonly [number, number] =
    sweepL === 0 && sweepR === 1 ? FULL_SWEEP : [sweepL, Math.max(sweepL, sweepR)];
  const highlight: readonly [number, number] =
    highlightL === 0 && highlightR === 0 ? HIGHLIGHT_OFF : [highlightL, highlightR];
  return {
    alpha,
    dxEm,
    dyEm,
    scale,
    blurEm,
    sweep,
    rotYRad,
    shineU,
    rotZRad,
    dzEm,
    rotXRad,
    scaleX,
    scaleY,
    clipFinal,
    colorMix,
    weightEm,
    softEm,
    chromaEm,
    highlight,
  };
}

/** The shine band's position along `SHINE_AXIS` for an element with layout `bounds` ([minX, minY, maxX, maxY]) at eased progress `shineU`. Pure math (golden-pinned): project the four corners on the axis, the band centre sweeps from its trailing edge just touching the low corner (u=0) to its leading edge fully exited (u=1). Returns null when the shine is off or unmeasurable. */
export function shineBand(
  bounds: readonly [number, number, number, number] | null,
  shineU: number,
): { centerS: number; invHalfWidthS: number } | null {
  if (shineU < 0 || !bounds) return null;
  const [minX, minY, maxX, maxY] = bounds;
  const [ax, ay] = SHINE_AXIS;
  const s1 = minX * ax + minY * ay;
  const s2 = maxX * ax + minY * ay;
  const s3 = minX * ax + maxY * ay;
  const s4 = maxX * ax + maxY * ay;
  const sMin = Math.min(s1, s2, s3, s4);
  const sMax = Math.max(s1, s2, s3, s4);
  const halfW = SHINE_HALF_W * (sMax - sMin);
  if (halfW <= 0) return null;
  const centerS = sMin - halfW + (sMax - sMin + 2 * halfW) * shineU;
  return { centerS, invHalfWidthS: 1 / halfW };
}

/** The underline-draw rule's 0..1 draw progress at `localMs` (block-level, no unit delay; the renderer draws the quad): the in draws over the first UNDERLINE_DRAW_P of the eased window; an underline-draw out re-draws the rule, holds, then wipes it off from UNDERLINE_OUT_WIPE_P; any other out wipes it with the fade. 0 when neither side is underline-draw. */
export function underlineProgress(timing: TextAnimTiming, localMs: number): number {
  const { anim, to, outAt } = timing;
  const inActive = anim.preset === "underline-draw";
  const outActive = anim.outPreset === "underline-draw";
  if (!inActive && !outActive) return 0;
  const durationMs = Math.max(1, to - timing.from);
  // The same delay shift as sampleTextUnit: the rule draws late with the text, the out never shifts.
  const from = anim.delayMs === undefined ? timing.from : timing.from + anim.delayMs;
  const q = outAt === undefined ? 0 : ease(anim.ease, clamp01((localMs - outAt) / durationMs));
  if (q > 0) {
    if (!outActive) {
      const p = ease(anim.ease, clamp01((localMs - from) / durationMs));
      return clamp01(p / UNDERLINE_DRAW_P) * (1 - q);
    }
    if (q < UNDERLINE_OUT_REDRAW_P) return q / UNDERLINE_OUT_REDRAW_P;
    if (q < UNDERLINE_OUT_WIPE_P) return 1;
    return clamp01((1 - q) / (1 - UNDERLINE_OUT_WIPE_P));
  }
  if (!inActive) return 0;
  const p = ease(anim.ease, clamp01((localMs - from) / durationMs));
  return clamp01(p / UNDERLINE_DRAW_P);
}

/** Stagger units measured from a completed troika typeset: `startX`/`endX` are each unit's layout-space X extent, kept for ALL granularities (mask-reveal's per-unit sweep stays X-based; each paragraph wipes left→right). `edgeKey[i]` is the decision boundary a glyph's centre is compared against in the vertex shader, in KEY space: layout X for char/word, −Y for the paragraph granularities, midway between unit i's end and unit i+1's start, +∞ for the last; char/word edge values are bit-for-bit the legacy `edgeX`. All arrays are `count` long, `count ≤ MAX_STAGGER_UNITS`. */
export interface StaggerUnits {
  count: number;
  startX: Float32Array;
  endX: Float32Array;
  edgeKey: Float32Array;
  /** Per-unit vertical centre in layout space (the scatter tilt drift needs unit centres; single-line text sits near 0). */
  centerY: Float32Array;
  /** The unit-walk axis the shader variant must be mounted with. */
  axis: StaggerAxis;
}

interface UnitExtent {
  startX: number;
  endX: number;
  keyStart: number;
  keyEnd: number;
  minY: number;
  maxY: number;
}

/** Segment `text` into stagger units using troika's per-char caret positions (`[startX, endX, bottomY, topY]` per char, in anchor-adjusted layout space, computed on every sync); whitespace splits words and belongs to no unit, and paragraph granularities split on `\n` (paragraph) / blank lines (`/^\s*$/`, paragraph-group) and key their decision edges on −Y (top-to-bottom text order walks ascending keys). Texts with more units than MAX_STAGGER_UNITS merge evenly into buckets, preserving text order. LTR only, RTL text staggers by layout position, not reading order. */
export function computeStaggerUnits(
  text: string,
  granularity: StaggerGranularity,
  caretPositions: Float32Array,
): StaggerUnits {
  const axis: StaggerAxis =
    granularity === "paragraph" || granularity === "paragraph-group" ? "-y" : "x";
  const charCount = Math.min(text.length, Math.floor(caretPositions.length / 4));
  const raw: UnitExtent[] = [];
  if (axis === "-y") {
    const ids = paragraphUnitIds(text, granularity === "paragraph-group");
    let lastId = -1;
    let current: UnitExtent | null = null;
    for (let i = 0; i < charCount; i++) {
      const id = ids[i];
      if (id < 0) continue;
      const startX = Math.min(caretPositions[i * 4], caretPositions[i * 4 + 1]);
      const endX = Math.max(caretPositions[i * 4], caretPositions[i * 4 + 1]);
      // key = −y: the char's [−topY, −bottomY] extent (min/max tolerates swapped rows).
      const keyLo = Math.min(-caretPositions[i * 4 + 3], -caretPositions[i * 4 + 2]);
      const keyHi = Math.max(-caretPositions[i * 4 + 3], -caretPositions[i * 4 + 2]);
      const yLo = Math.min(caretPositions[i * 4 + 2], caretPositions[i * 4 + 3]);
      const yHi = Math.max(caretPositions[i * 4 + 2], caretPositions[i * 4 + 3]);
      if (current === null || id !== lastId) {
        current = { startX, endX, keyStart: keyLo, keyEnd: keyHi, minY: yLo, maxY: yHi };
        raw.push(current);
        lastId = id;
      } else {
        current.startX = Math.min(current.startX, startX);
        current.endX = Math.max(current.endX, endX);
        current.keyStart = Math.min(current.keyStart, keyLo);
        current.keyEnd = Math.max(current.keyEnd, keyHi);
        current.minY = Math.min(current.minY, yLo);
        current.maxY = Math.max(current.maxY, yHi);
      }
    }
  } else {
    // char/word: the legacy walk with CODEPOINT stepping (bit-identical floats for BMP-only text, the existing-project contract); an astral codepoint spans two caret slots (troika splits its advance across the surrogate pair) and counts as ONE char, so it can never crack into two stagger units. Emoji never reach here (PUA substitution upstream); this covers raw astral input like mathematical alphanumerics.
    let current: UnitExtent | null = null;
    for (let i = 0; i < charCount; ) {
      const cp = text.codePointAt(i) ?? 0;
      const span = cp > 0xffff && i + 1 < charCount ? 2 : 1;
      if (/\s/.test(text[i])) {
        current = null;
        i += span;
        continue;
      }
      let startX = Number.POSITIVE_INFINITY;
      let endX = Number.NEGATIVE_INFINITY;
      let yLo = Number.POSITIVE_INFINITY;
      let yHi = Number.NEGATIVE_INFINITY;
      for (let j = i; j < i + span; j++) {
        startX = Math.min(startX, caretPositions[j * 4], caretPositions[j * 4 + 1]);
        endX = Math.max(endX, caretPositions[j * 4], caretPositions[j * 4 + 1]);
        yLo = Math.min(yLo, caretPositions[j * 4 + 2], caretPositions[j * 4 + 3]);
        yHi = Math.max(yHi, caretPositions[j * 4 + 2], caretPositions[j * 4 + 3]);
      }
      if (granularity === "char" || current === null) {
        current = { startX, endX, keyStart: startX, keyEnd: endX, minY: yLo, maxY: yHi };
        raw.push(current);
      } else {
        current.startX = Math.min(current.startX, startX);
        current.endX = Math.max(current.endX, endX);
        current.keyStart = current.startX;
        current.keyEnd = current.endX;
        current.minY = Math.min(current.minY, yLo);
        current.maxY = Math.max(current.maxY, yHi);
      }
      if (granularity === "char") current = null;
      i += span;
    }
  }

  const merged = mergeUnits(raw, MAX_STAGGER_UNITS);
  const count = merged.length;
  const startX = new Float32Array(count);
  const endX = new Float32Array(count);
  const edgeKey = new Float32Array(count);
  const centerY = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    startX[i] = merged[i].startX;
    endX[i] = merged[i].endX;
    edgeKey[i] = i < count - 1 ? (merged[i].keyEnd + merged[i + 1].keyStart) / 2 : EDGE_SENTINEL;
    centerY[i] = (merged[i].minY + merged[i].maxY) / 2;
  }
  return { count, startX, endX, edgeKey, centerY, axis };
}

/** CPU twin of the stagger shader's unit walk (staggerMaterial VERTEX_TRANSFORM / OVER_WALK): the last unit whose decision edge has not been passed, keyed on layout X (char/word) or −Y (paragraph). Emoji quads use it so a quad joins exactly the unit the shader would give a glyph at the same position. */
export function unitIndexForKey(units: StaggerUnits | null, key: number): number {
  if (!units) return 0;
  let unit = 0;
  for (let i = 0; i < Math.min(units.count, MAX_STAGGER_UNITS); i++) {
    unit = i;
    if (key <= units.edgeKey[i]) break;
  }
  return unit;
}

/** Per-char unit ids for the paragraph granularities (−1 = belongs to no unit): `paragraph` treats every non-blank line as a unit, `paragraph-group` (`group` true) shares a unit across consecutive non-blank lines and splits on blank lines (whitespace-tolerant). */
function paragraphUnitIds(text: string, group: boolean): Int32Array {
  const ids = new Int32Array(text.length).fill(-1);
  let unit = -1;
  let inGroup = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const blank = /^\s*$/.test(line);
    if (!blank) {
      if (!group || !inGroup) unit++;
      // Codepoint stepping: both halves of a surrogate pair share the codepoint's unit id.
      for (let i = 0; i < line.length; ) {
        const cp = line.codePointAt(i) ?? 0;
        const span = cp > 0xffff && i + 1 < line.length ? 2 : 1;
        if (!/\s/.test(line[i])) {
          for (let j = 0; j < span; j++) ids[offset + i + j] = unit;
        }
        i += span;
      }
    }
    inGroup = group && !blank;
    offset += line.length + 1;
  }
  return ids;
}

function mergeUnits(units: UnitExtent[], max: number): UnitExtent[] {
  if (units.length <= max) return units;
  const merged: UnitExtent[] = [];
  for (let b = 0; b < max; b++) {
    const lo = Math.floor((b * units.length) / max);
    const hi = Math.floor(((b + 1) * units.length) / max) - 1;
    let startX = units[lo].startX;
    let endX = units[lo].endX;
    let keyStart = units[lo].keyStart;
    let keyEnd = units[lo].keyEnd;
    let minY = units[lo].minY;
    let maxY = units[lo].maxY;
    for (let i = lo + 1; i <= hi; i++) {
      startX = Math.min(startX, units[i].startX);
      endX = Math.max(endX, units[i].endX);
      keyStart = Math.min(keyStart, units[i].keyStart);
      keyEnd = Math.max(keyEnd, units[i].keyEnd);
      minY = Math.min(minY, units[i].minY);
      maxY = Math.max(maxY, units[i].maxY);
    }
    merged.push({ startX, endX, keyStart, keyEnd, minY, maxY });
  }
  return merged;
}
