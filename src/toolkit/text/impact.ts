import { ease } from "../../engine/ease";
import { STAMP_SCALE_DEFAULTS, type StampScaleOptions, stampScale } from "../motion/stampScale";
import {
  type ResolvedTextAnimation,
  sampleTextUnit,
  type TextPresetName,
  type TextUnitSample,
  typewriterStops,
} from "./presets";

/** A unit has landed once it is this close to rest, as the capture probe sees rendered pixels (tools/impact-probe holds these to it): size, opacity and travel in em, a tilt by how much it still foreshortens, a roll by its angle, weight by the ink it moves. */
const LANDED = 0.012;
const LANDED_DEPTH_EM = 0.1;
const LANDED_TILT = 0.02;
const LANDED_ROLL_RAD = 0.03;
const LANDED_WEIGHT_EM = 0.001;
/** A wipe's accent block is bright: it hasn't landed while a sliver of it shows. */
const LANDED_BLOCK = 0.001;
/** chromatic stacks its fill with two echoes, so it reads opaque well before each layer is. */
const CHROMA_LAYERS = 3;

/** How far a sampled unit still is from rest, as a multiple of what counts as landed: 1 or below has landed. Colour is left out: it isn't motion. */
export function unitRestResidual(s: TextUnitSample): number {
  const alpha = s.chromaEm > 0 ? 1 - (1 - s.alpha) ** CHROMA_LAYERS : s.alpha;
  return Math.max(
    (1 - alpha) / LANDED,
    Math.abs(s.scale * s.scaleX - 1) / LANDED,
    Math.abs(s.scale * s.scaleY - 1) / LANDED,
    Math.abs(s.dxEm) / LANDED,
    Math.abs(s.dyEm) / LANDED,
    Math.abs(s.dzEm) / LANDED_DEPTH_EM,
    (1 - Math.cos(s.rotXRad)) / LANDED_TILT,
    (1 - Math.cos(s.rotYRad)) / LANDED_TILT,
    Math.abs(s.rotZRad) / LANDED_ROLL_RAD,
    s.blurEm / LANDED,
    s.softEm / LANDED,
    Math.abs(s.weightEm) / LANDED_WEIGHT_EM,
    (1 - (s.sweep[1] - s.sweep[0])) / LANDED,
    (s.highlight[1] - s.highlight[0]) / LANDED_BLOCK,
  );
}

// Moves measured from the element's centre: a representative unit one em off it stands in for the real layout.
const CENTRE_RELATIVE: ReadonlySet<TextPresetName> = new Set([
  "tracking",
  "scatter-scale",
  "orbit",
  "converge",
]);
const REPRESENTATIVE_CENTRE_EM: readonly [number, number] = [-1, 0];
/** build's line re-centre over its first word, em: how far the anchor still has to carry it when it starts. */
const REPRESENTATIVE_BUILD_SHIFT_EM = 1.5;

const cache = new Map<string, number>();
const CACHE_LIMIT = 512;
/** The searches step at 1 ms up to this many samples, then coarser, so a huge authored window can't stall a render. */
const MAX_SEARCH_STEPS = 4096;

/** How long after its window opens a motion's first unit lands, ms: the first moment it sits at rest size and full opacity (an overshoot's crossing counts, a fade only counts when it's opaque). `windowMs` is the unit's in duration; `count` matters only to motions that divide the window between units (word-cycle, spotlight, typewriter's keystrokes). Excludes `delayMs`. */
export function textImpactMs(anim: ResolvedTextAnimation, windowMs: number, count = 1): number {
  const window = Math.max(1, windowMs);
  const units = Math.max(1, count);
  if (anim.preset === "typewriter") return window / units;
  // The v0 linear ramp: it lands where it ends.
  if (anim.preset === "none") return window;
  const key = [
    anim.preset,
    anim.ease,
    window,
    units,
    anim.params.startScale,
    anim.params.twistStartScale,
    anim.params.twistDir,
    anim.params.buildShiftEm,
    anim.distance,
  ].join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resting: ResolvedTextAnimation = {
    ...anim,
    outPreset: "none",
    staggerMs: 0,
    delayMs: undefined,
  };
  const ctx = {
    count: units,
    ...(CENTRE_RELATIVE.has(anim.preset) ? { unitCenterEm: REPRESENTATIVE_CENTRE_EM } : {}),
  };
  let landed = window;
  const step = Math.max(1, window / MAX_SEARCH_STEPS);
  for (let ms = 0; ms <= window; ms += step) {
    const lineShiftEm =
      anim.preset === "build"
        ? REPRESENTATIVE_BUILD_SHIFT_EM * (1 - ease(anim.ease, ms / window))
        : undefined;
    const sample = sampleTextUnit(
      { anim: resting, from: 0, to: window },
      0,
      ms,
      lineShiftEm === undefined ? ctx : { ...ctx, lineShiftEm },
    );
    if (unitRestResidual(sample) <= 1) {
      landed = ms;
      break;
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, landed);
  return landed;
}

/** The units a motion divides its window between, from the copy: only word-cycle, spotlight and typewriter read it. */
export function impactUnitCount(anim: ResolvedTextAnimation, text: string): number {
  if (anim.preset === "typewriter") return typewriterStops(text).length;
  if (anim.preset === "word-cycle" || anim.preset === "spotlight") {
    return text.trim().split(/\s+/).length;
  }
  return 1;
}

/** The reveal window that lands its first unit on `hitAt`: keeps the authored in duration and moves the start back by the motion's lead (delay included). */
export function hitWindow(
  hitAt: number,
  anim: ResolvedTextAnimation,
  from: number,
  to: number,
  count = 1,
): { from: number; to: number } {
  const start = hitAt - textImpactMs(anim, to - from, count) - (anim.delayMs ?? 0);
  return { from: start, to: start + (to - from) };
}

/** How long a stamp pop takes to first reach full size, ms: the crossing on the way up to its overshoot. */
export function stampImpactMs(opts: StampScaleOptions = {}): number {
  const scale = stampScale(opts);
  const end =
    (opts.inMs ?? STAMP_SCALE_DEFAULTS.inMs) + (opts.settleMs ?? STAMP_SCALE_DEFAULTS.settleMs);
  const step = Math.max(1, end / MAX_SEARCH_STEPS);
  for (let ms = 0; ms <= end; ms += step) {
    if (Math.abs(scale(ms) - 1) <= LANDED) return ms;
  }
  return end;
}
