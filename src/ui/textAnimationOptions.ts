import type { TextAnimationSpec } from "../theme/tokens";
import {
  DEFAULT_START_SCALE,
  isTextPresetName,
  type TextDirection,
  type TextPresetName,
} from "../toolkit/text/presets";

/** Pure vocabulary + spec builders for the text-motion picker and the scene wizards, the stageOptions pattern: every sidecar shape emitted here is structure-pinned in unit tests against the shared `parseTextAnimationSpec`, so a chip can never silently write a spec that degrades to "no override". */

/** One picker card. Param capabilities drive the adaptive panel. */
export interface TextPresetMeta {
  preset: TextPresetName;
  label: string;
  hint: string;
  /** fade-scale: the startScale slider + Shine toggle apply. */
  hasScaleParams?: boolean;
  /** twist-scale: the from-left/from-right chips apply. */
  hasDirection?: boolean;
  /** scatter-scale: per-character by design, "all at once" would collapse it. */
  perCharacter?: boolean;
}

/** Card order = grid order (the Theme-default chip renders before all of these). */
export const TEXT_PRESET_CATALOG: readonly TextPresetMeta[] = [
  { preset: "none", label: "None", hint: "The plain linear reveal — no preset motion" },
  { preset: "fade", label: "Fade", hint: "A clean opacity fade-in" },
  { preset: "fade-up", label: "Fade up", hint: "Fades in while rising into place" },
  { preset: "blur-in", label: "Blur in", hint: "Sharpens out of a soft blur" },
  { preset: "slide", label: "Slide", hint: "Slides in from the left as it fades" },
  { preset: "mask-reveal", label: "Mask reveal", hint: "Wipes on left-to-right" },
  {
    preset: "fade-scale",
    label: "Fade scale",
    hint: "Grows (or settles) to size — optional shine sweep",
    hasScaleParams: true,
  },
  {
    preset: "twist-scale",
    label: "Twist scale",
    hint: "A perspective card turn to rest",
    hasDirection: true,
  },
  {
    preset: "scatter-scale",
    label: "Scatter scale",
    hint: "Every character flies in from the camera on its own clock",
    perCharacter: true,
  },
] as const;

/** How the text is delivered, one control folding stagger + delivery spellings. */
export type DeliveryChoice =
  | "default"
  | "all-at-once"
  | "word"
  | "char"
  | "by-paragraph"
  | "by-paragraph-group";

export const DELIVERY_OPTIONS: readonly { id: DeliveryChoice; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "all-at-once", label: "All at once" },
  { id: "word", label: "By word" },
  { id: "char", label: "By letter" },
  { id: "by-paragraph", label: "By paragraph" },
  { id: "by-paragraph-group", label: "By group" },
] as const;

/** Explicit per-delivery delays the picker writes when the ms field is untouched; word/char must be non-zero in the spec (`spec.stagger` is only consulted when `staggerMs > 0` at resolve), and the paragraph spellings match `DEFAULT_STAGGER_MS`. */
export const DELIVERY_DEFAULT_MS: Record<DeliveryChoice, number> = {
  default: 0,
  "all-at-once": 0,
  word: 90,
  char: 35,
  "by-paragraph": 160,
  "by-paragraph-group": 260,
};

/** The picker's working state; everything the adaptive panel edits. */
export interface TextAnimationDraft {
  preset: TextPresetName;
  /** Preserved from an existing spec; the picker itself doesn't surface an out. */
  out: TextPresetName;
  delivery: DeliveryChoice;
  /** null = the delivery's default delay (written explicitly). */
  staggerMs: number | null;
  startScale: number;
  shine: boolean;
  direction: TextDirection;
}

export function defaultDraft(preset: TextPresetName): TextAnimationDraft {
  return {
    preset,
    out: "none",
    delivery: "default",
    staggerMs: null,
    startScale: DEFAULT_START_SCALE,
    shine: false,
    direction: "from-left",
  };
}

/** The whole-spec sidecar shape for a draft; what `doc.textAnimation` receives. */
export function draftToSpec(draft: TextAnimationDraft): TextAnimationSpec {
  const spec: TextAnimationSpec = {
    in: draft.preset,
    out: draft.out,
    staggerMs: draft.staggerMs ?? DELIVERY_DEFAULT_MS[draft.delivery],
  };
  if (draft.delivery === "word" || draft.delivery === "char") spec.stagger = draft.delivery;
  else if (draft.delivery !== "default") spec.delivery = draft.delivery;
  if (draft.preset === "fade-scale") {
    if (draft.startScale !== DEFAULT_START_SCALE) spec.startScale = draft.startScale;
    if (draft.shine) spec.shine = true;
  }
  if (draft.preset === "twist-scale" && draft.direction === "from-right") {
    spec.direction = "from-right";
  }
  return spec;
}

/** Seed a draft from an existing spec (unknown preset names coerce like the resolver). */
export function specToDraft(spec: TextAnimationSpec): TextAnimationDraft {
  const draft = defaultDraft(isTextPresetName(spec.in) ? spec.in : "fade");
  if (isTextPresetName(spec.out)) draft.out = spec.out;
  if (spec.stagger) draft.delivery = spec.stagger;
  else if (spec.delivery) draft.delivery = spec.delivery;
  if (spec.staggerMs > 0 && spec.staggerMs !== DELIVERY_DEFAULT_MS[draft.delivery]) {
    draft.staggerMs = spec.staggerMs;
  }
  if (spec.startScale !== undefined) draft.startScale = spec.startScale;
  if (spec.shine !== undefined) draft.shine = spec.shine;
  if (spec.direction !== undefined) draft.direction = spec.direction;
  return draft;
}

/** One-line description of a spec; the Theme-default chip's hint. */
export function describeSpec(spec: TextAnimationSpec | undefined): string {
  if (!spec || spec.in === "none") return "No preset motion";
  const meta = TEXT_PRESET_CATALOG.find((m) => m.preset === spec.in);
  const label = meta?.label ?? spec.in;
  const delivery = spec.stagger ?? spec.delivery;
  const deliveryLabel = DELIVERY_OPTIONS.find((o) => o.id === delivery)?.label;
  return deliveryLabel && delivery !== "all-at-once" ? `${label} · ${deliveryLabel}` : label;
}
