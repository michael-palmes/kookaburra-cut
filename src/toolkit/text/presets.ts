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
] as const;
export type TextPresetName = (typeof TEXT_PRESET_NAMES)[number];

export function isTextPresetName(name: string): name is TextPresetName {
  return (TEXT_PRESET_NAMES as readonly string[]).includes(name);
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
  /** fade-scale: sweep the soft white shine band once, during the scale-in only. */
  shine: boolean;
  /** twist-scale: +1 = from-left, −1 = from-right. */
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
  params: TextPresetParams;
}

export interface ResolveTextAnimationProps {
  preset?: string;
  outPreset?: string;
  ease?: string;
  stagger?: StaggerGranularity;
  staggerMs?: number;
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
  else granularity = staggerMs > 0 && preset !== "none" ? "word" : null;
  // A granularity request without any delay configured gets the granularity's default, unless the scene explicitly passed staggerMs={0}, which wins.
  if (granularity && staggerMs === 0 && props.staggerMs === undefined) {
    staggerMs = DEFAULT_STAGGER_MS[granularity];
  }
  const rawStart = props.startScale ?? spec?.startScale;
  const direction = props.direction ?? spec?.direction;
  return {
    preset,
    outPreset,
    ease: props.ease ?? theme.motion.easings.standard,
    staggerMs,
    granularity: preset === "none" ? null : granularity,
    params: {
      startScale: rawStart === undefined ? DEFAULT_START_SCALE : clampStartScale(rawStart),
      shine: props.shine ?? spec?.shine ?? false,
      twistDir: direction === "from-right" ? -1 : 1,
    },
  };
}

/** The doc fields the force-aware resolver reads (a `SceneDoc` structural subset, typed here so the pure text layer never imports the engine schema). */
export interface TextAnimationDocFields {
  textAnimation?: TextAnimationSpec;
  textAnimationForce?: boolean;
}

/** Sidecar-aware resolution: the shared resolver, honouring the doc's `textAnimationForce`; when set, the primitive's own TSX animation props are IGNORED and the sidecar/theme spec drives (the app's "Override coded motion"; timing props like from/to/outAt are not animation props and keep applying). Absent flag = the normal prop-wins order. */
export function resolveTextAnimationWithDoc(
  props: ResolveTextAnimationProps,
  theme: Theme,
  doc: TextAnimationDocFields | null | undefined,
): ResolvedTextAnimation | null {
  const force = doc?.textAnimationForce === true;
  return resolveTextAnimation(force ? {} : props, theme, doc?.textAnimation);
}

/** Whether a primitive's props configure its own animation, exactly the resolver's props-only "configured" test (what the coded-motion registry reports). */
export function hasOwnAnimationProps(props: ResolveTextAnimationProps): boolean {
  return (
    props.preset !== undefined ||
    props.outPreset !== undefined ||
    props.ease !== undefined ||
    props.stagger !== undefined ||
    props.staggerMs !== undefined ||
    props.startScale !== undefined ||
    props.shine !== undefined ||
    props.direction !== undefined ||
    props.delivery !== undefined
  );
}

/** Float32-safe "past every glyph" sentinel for the last unit's decision edge. */
export const EDGE_SENTINEL = 1e30;

/** The animation window: `from`→`to` plays the in preset; `outAt` (optional) starts the out. */
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
}

/** Optional per-unit geometry for sampling: lets scatter-scale spread its random delays over the real unit count and derive the element-tilt drift from the unit's centre (em, relative to the ELEMENT centre); absent = one whole-block unit. */
export interface ScatterSampleContext {
  count: number;
  unitCenterEm?: readonly [number, number];
}

const FULL_SWEEP: readonly [number, number] = [0, 1];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Sample unit `unitIndex` at local scene time `localMs`: unit i's window is the block's window shifted by `i × staggerMs` (each unit keeps the full in duration, so the last unit finishes `(units−1) × staggerMs` after `to`); scatter-scale replaces the ordered delay with a hashed one spread over the same budget and jitters each unit's duration, pure functions of the unit index, so preview and export agree. */
export function sampleTextUnit(
  timing: TextAnimTiming,
  unitIndex: number,
  localMs: number,
  ctx?: ScatterSampleContext,
): TextUnitSample {
  const { anim, from, to, outAt } = timing;
  const durationMs = Math.max(1, to - from);
  const scattering = anim.preset === "scatter-scale" || anim.outPreset === "scatter-scale";
  let delay = unitIndex * anim.staggerMs;
  let unitDurationMs = durationMs;
  if (scattering) {
    const spread = Math.max(0, (ctx?.count ?? 1) - 1) * anim.staggerMs;
    delay = unitHash01(unitIndex, 0) * spread;
    unitDurationMs =
      durationMs * (SCATTER_RATE_MIN + (1 - SCATTER_RATE_MIN) * unitHash01(unitIndex, 1));
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

  switch (anim.preset) {
    case "none":
      break;
    case "fade":
      alpha = p;
      break;
    case "fade-up":
      alpha = p;
      dyEm = -(1 - p) * RISE_EM;
      break;
    case "blur-in":
      alpha = p;
      blurEm = (1 - p) * BLUR_EM;
      scale = 1 + (1 - p) * POP_SCALE;
      break;
    case "slide":
      alpha = p;
      dxEm = -(1 - p) * SLIDE_EM;
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
    case "twist-scale":
      alpha = p;
      scale = TWIST_START_SCALE + (1 - TWIST_START_SCALE) * p;
      rotYRad = anim.params.twistDir * (1 - p) * TWIST_RAD;
      break;
    case "scatter-scale": {
      const settle = 1 - p;
      alpha = clamp01(p / SCATTER_FADE_P);
      rotZRad =
        (SCATTER_ROLL_MIN_RAD +
          (SCATTER_ROLL_MAX_RAD - SCATTER_ROLL_MIN_RAD) * unitHash01(unitIndex, 2)) *
        settle;
      dzEm = SCATTER_DEPTH_EM * settle;
      if (ctx?.unitCenterEm) {
        // The unit's share of the element tilt: rotate its centre counter-clockwise by θ = TILT × settle about the element centre; the drift is the arc offset.
        const theta = SCATTER_TILT_RAD * settle;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const [cx, cy] = ctx.unitCenterEm;
        dxEm += cx * (cos - 1) - cy * sin;
        dyEm += cx * sin + cy * (cos - 1);
      }
      break;
    }
  }

  if (q > 0) {
    switch (anim.outPreset) {
      case "none":
        break;
      case "fade":
        alpha *= 1 - q;
        break;
      case "fade-up":
        alpha *= 1 - q;
        dyEm += q * RISE_EM;
        break;
      case "blur-in":
        alpha *= 1 - q;
        blurEm += q * BLUR_EM;
        scale *= 1 + q * POP_SCALE;
        break;
      case "slide":
        alpha *= 1 - q;
        dxEm += q * SLIDE_EM;
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
      case "twist-scale":
        alpha *= 1 - q;
        scale *= TWIST_START_SCALE + (1 - TWIST_START_SCALE) * (1 - q);
        rotYRad += anim.params.twistDir * q * TWIST_RAD;
        break;
      case "scatter-scale": {
        alpha *= 1 - q;
        rotZRad +=
          (SCATTER_ROLL_MIN_RAD +
            (SCATTER_ROLL_MAX_RAD - SCATTER_ROLL_MIN_RAD) * unitHash01(unitIndex, 2)) *
          q;
        dzEm += SCATTER_DEPTH_EM * q;
        if (ctx?.unitCenterEm) {
          const theta = SCATTER_TILT_RAD * q;
          const cos = Math.cos(theta);
          const sin = Math.sin(theta);
          const [cx, cy] = ctx.unitCenterEm;
          dxEm += cx * (cos - 1) - cy * sin;
          dyEm += cx * sin + cy * (cos - 1);
        }
        break;
      }
    }
  }

  const sweep: readonly [number, number] =
    sweepL === 0 && sweepR === 1 ? FULL_SWEEP : [sweepL, Math.max(sweepL, sweepR)];
  return { alpha, dxEm, dyEm, scale, blurEm, sweep, rotYRad, shineU, rotZRad, dzEm };
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
