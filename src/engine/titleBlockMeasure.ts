/** Multi-line growth for the in-world `TitleBlock`: its title and subtitle are typeset off-screen through the panel measure cache (framePanelMeasure.ts), and whatever the block gained beyond ONE line cascades the header icon up and the subtitle down. Single-line text yields a hard 0: the line count is rounded against a single-line probe of the same font stack (wrapping off, hard breaks folded to spaces), and one line short-circuits before any arithmetic, so a standing layout keeps TitleBlock's hand-authored constants bit-for-bit. A TitleBlock's props only exist once its scene is in the canvas tree, so the export preamble settles these AFTER the scene-host barrier (`awaitTitleMeasuresSettled`), the FramePanel request/measured lifecycle applied to a tree the preamble cannot enumerate ahead of the mount. */

import { parseFontString } from "../theme/fontRef";
import { fontUrl } from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import { prepareEmojiText } from "../toolkit/text/emojiText";
import {
  awaitPanelMeasuresIdle,
  measuredPanelTextHeight,
  type PanelTextSpec,
} from "./framePanelMeasure";
import { yieldMacrotask } from "./macrotask";
import type { SceneDoc } from "./sceneDocSchema";

export interface TitleTextInput {
  text: string;
  face: "headline" | "body";
  /** Size before any sidecar `<textKey>Size` multiplier, i.e. what AnimatedHeadline receives. */
  fontSize: number;
  /** Wrap width in world units; unset means troika's own unbounded default. */
  maxWidth?: number;
  textAlign: "left" | "center" | "right";
  /** The sidecar key this headline renders, or undefined when it registers none (TextFallback's `register={false}`), which is also when no `textStyle` override applies. */
  textKey?: string;
}

export interface TitleCascade {
  /** World height the title block gained beyond one line; exactly 0 for single-line text. */
  titleGrowth: number;
  subtitleGrowth: number;
  /** Cache misses along this solve; request them, then re-solve when they land. */
  pending: PanelTextSpec[];
}

/** The no-growth solution, shared so an unmeasurable or already-settled block keeps a stable identity across re-renders. */
export const NO_TITLE_CASCADE: TitleCascade = { titleGrowth: 0, subtitleGrowth: 0, pending: [] };

function specOf(
  input: TitleTextInput | null,
  theme: Theme,
  doc: SceneDoc | undefined,
): PanelTextSpec | null {
  if (!input?.text.trim()) return null;
  // Mirror AnimatedHeadline's sidecar dispatch for the overrides that change layout (font, size, line height), so the measured block is the rendered block.
  const key = input.textKey;
  const fontValue = key ? doc?.textStyle?.[`${key}Font`] : undefined;
  const sizeMul = key ? doc?.textStyle?.[`${key}Size`] : undefined;
  const lineHeight = key ? doc?.textStyle?.[`${key}LineHeight`] : undefined;
  return {
    text: prepareEmojiText(input.text).text,
    font: fontUrl(
      typeof fontValue === "string" ? parseFontString(fontValue) : theme.typography[input.face],
    ),
    fontSize: typeof sizeMul === "number" ? input.fontSize * sizeMul : input.fontSize,
    maxWidth: input.maxWidth ?? Number.POSITIVE_INFINITY,
    textAlign: input.textAlign,
    ...(typeof lineHeight === "number" ? { lineHeight } : {}),
  };
}

/** One line of the same text in the same font stack: block height then comes from this text's own metrics, not from a probe glyph's. */
function probeOf(spec: PanelTextSpec): PanelTextSpec {
  return { ...spec, text: spec.text.replace(/[\r\n]+/g, " "), maxWidth: Number.POSITIVE_INFINITY };
}

/** Growth beyond one line from the two measured heights. The line count is ROUNDED, never a float compare, and one line returns the literal 0, so the caller's base positions are left untouched by construction. */
export function growthFromHeights(block: number, oneLine: number): number {
  if (!(oneLine > 0)) return 0;
  return Math.round(block / oneLine) > 1 ? block - oneLine : 0;
}

function growthOf(spec: PanelTextSpec | null, pending: PanelTextSpec[]): number {
  if (!spec) return 0;
  const probe = probeOf(spec);
  const block = measuredPanelTextHeight(spec);
  const oneLine = measuredPanelTextHeight(probe);
  if (block === null) pending.push(spec);
  if (oneLine === null) pending.push(probe);
  if (block === null || oneLine === null) return 0;
  return growthFromHeights(block, oneLine);
}

/** Solve one TitleBlock's growth. Pure given a warm cache, so preview and export walk the same numbers. */
export function solveTitleCascade(
  title: TitleTextInput | null,
  subtitle: TitleTextInput | null,
  theme: Theme,
  doc: SceneDoc | undefined,
): TitleCascade {
  const titleSpec = specOf(title, theme, doc);
  const subtitleSpec = specOf(subtitle, theme, doc);
  if (!titleSpec && !subtitleSpec) return NO_TITLE_CASCADE;
  const pending: PanelTextSpec[] = [];
  const titleGrowth = growthOf(titleSpec, pending);
  const subtitleGrowth = growthOf(subtitleSpec, pending);
  if (titleGrowth === 0 && subtitleGrowth === 0 && pending.length === 0) return NO_TITLE_CASCADE;
  return { titleGrowth, subtitleGrowth, pending };
}

const outstanding = new Map<string, number>();

/** Mounted TitleBlocks report their outstanding measurements here (cleared on the render that consumes them), so the export barrier can wait on a tree it cannot enumerate. */
export function reportTitleMeasures(id: string, count: number): void {
  if (count > 0) outstanding.set(id, count);
  else outstanding.delete(id);
}

export function clearTitleMeasures(id: string): void {
  outstanding.delete(id);
}

function outstandingCount(): number {
  let total = 0;
  for (const count of outstanding.values()) total += count;
  return total;
}

/** Export barrier: settle every typeset the mounted TitleBlocks asked for AND let the tree re-render with them, or frame 0 captures the pre-measure layout and a warm second run disagrees with it (Verify ×2). Deterministic by construction: the spin count varies, the outcome never does. */
export async function awaitTitleMeasuresSettled(): Promise<void> {
  for (let spins = 0; spins < 5000; spins++) {
    await awaitPanelMeasuresIdle();
    await yieldMacrotask();
    // The first pass never exits: report-on-commit means an empty map can simply mean the mount effects have not run yet.
    if (spins > 0 && outstandingCount() === 0) return;
  }
  throw new Error(`TitleBlock text measurements never settled: ${outstandingCount()} outstanding.`);
}
