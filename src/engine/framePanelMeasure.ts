/** Real troika heights for the overlay panel's title and subtitle: an off-screen `Text` typesets each (text, font, size, wrap width) once into a write-once cache, so the panel lays out from measured blocks instead of estimates. Wrap count depends on font size, and font size depends on the fit-to-column scale, so `solvePanelLayout` iterates that fixpoint: measure at the candidate size, recompute fit, re-measure, until reserved and rendered agree. Deterministic: same inputs, same troika 0.52.4 layout, same heights, same iteration sequence. The export preamble pre-warms the cache along the same iteration path (`preloadPanelMeasures`, the emoji-raster pattern) so frame 0 renders the settled layout; the preview falls back to the estimate until measurements land, then re-renders. */

import { Text } from "troika-three-text";
import { parseFontString } from "../theme/fontRef";
import { fontUrl } from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { prepareEmojiText } from "../toolkit/text/emojiText";
import type { FormatInfo } from "../toolkit/types";
import { framePanelLayout, frameTextAlign } from "./framePanelLayout";
import { estimateTitleLines } from "./framePanelText";
import {
  frameIconStyleKey,
  resolveTemplateManagedFrameIcon,
  resolveTemplateManagedTextBullets,
  resolveTemplateManagedTextCopy,
  usesSpecialisedTextRenderer,
} from "./managedText";
import type { SceneDoc } from "./sceneDocSchema";

/** Title size as a fraction of the column's width, clamped by its height (the title-slide size, before the fit-to-column scale). */
export const TITLE_WIDTH_FRACTION = 0.2;
export const TITLE_HEIGHT_FRACTION = 0.18;
/** The estimate fallback's per-line multiplier, until a measurement lands. */
export const LINE_HEIGHT = 1.2;
/** The estimate fallback's subtitle worst case. */
export const SUBTITLE_LINE_BUDGET = 2;
/** Subtitle and bullet sizes as a fraction of the title (bullets read as small body copy, well under the headline, like the reference slides). */
export const SUBTITLE_OF_TITLE = 0.44;
export const BULLET_OF_TITLE = 0.32;
/** Icon edge as a multiple of the title height, and its gap above the title in title-heights. */
export const ICON_SIZE = 1.25;
export const ICON_GAP = 0.4;
/** The header icon's own `textStyle` key, so the generic `<key>Size` multiplier steers it (the app's Size % control). */
export const ICON_TEXT_KEY = "icon";
export const FRAME_ICON_TEXT_KEY = "frameIcon";
/** The bullet marker, and the gap between it and the line's text. */
export const BULLET_MARKER = "•";
export const BULLET_GAP = "  ";
/** Gap below the title before the subtitle, in title-heights. */
export const TITLE_GAP = 0.35;
/** Extra gap between bullet lines, and the chip's gap above the bullets, in bullet-heights. */
export const BULLET_LINE_GAP = 0.6;
export const CHIP_GAP = 1.4;
/** Chip pill height as a fraction of the frame height (about 64px on a 1080p reference frame). */
export const CHIP_HEIGHT_FRAC = 0.059;
/** The body (bullets + chip) stacks directly under the header, this gap below it (title-heights). */
export const HEADER_BODY_GAP = 0.5;
/** Fit iterations: heights are near-linear in size, so the fixpoint settles in two passes; the third absorbs a wrap-count change at the smaller size. */
const FIT_ITERATIONS = 3;
/** Preload passes: each warms what the previous solve was missing, and the hanging indent adds a dependency level (its probes decide the bullets' wrap width) on top of the fit fixpoint. */
const PRELOAD_PASSES = 8;

export interface ManagedPanelTextRegionBounds {
  top: number;
  bottom: number;
}

export function managedPanelTextRegion(
  top: number,
  bottom: number,
  iconBudget: number,
  chipBudget: number,
): ManagedPanelTextRegionBounds {
  const boundedTop = top - Math.max(0, iconBudget);
  const boundedBottom = bottom + Math.max(0, chipBudget);
  return { top: boundedTop, bottom: Math.min(boundedTop, boundedBottom) };
}

export interface PanelTextSpec {
  /** The string troika lays out (emoji already substituted, the EmojiQuads contract). */
  text: string;
  /** Resolved font URL (the face AnimatedHeadline would use). */
  font: string;
  fontSize: number;
  maxWidth: number;
  textAlign: "left" | "center" | "right";
  /** Line-height multiplier when the caller pins one; unset leaves troika's own "normal". */
  lineHeight?: number;
}

function specKey(spec: PanelTextSpec): string {
  return `${spec.font}|${spec.fontSize}|${spec.maxWidth}|${spec.textAlign}|${spec.lineHeight ?? ""}|${spec.text}`;
}

/** A measured block's world size at the spec's font size. */
export interface PanelTextBlock {
  width: number;
  height: number;
}

const blocks = new Map<string, PanelTextBlock>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/** Measured block height in world units at the spec's size, or null until the typeset lands. */
export function measuredPanelTextHeight(spec: PanelTextSpec): number | null {
  return blocks.get(specKey(spec))?.height ?? null;
}

/** Measured block width AND height, for callers that need the box rather than the stack budget (the decoration gizmo). Null until the typeset lands. */
export function measuredPanelTextBlock(spec: PanelTextSpec): PanelTextBlock | null {
  return blocks.get(specKey(spec)) ?? null;
}

/** Kick a measurement (idempotent); listeners fire when the block lands. */
export function requestPanelTextMeasure(spec: PanelTextSpec): void {
  const key = specKey(spec);
  if (blocks.has(key) || inflight.has(key)) return;
  const job = new Promise<void>((resolve) => {
    const t = new Text();
    t.text = spec.text;
    t.font = spec.font;
    t.fontSize = spec.fontSize;
    t.maxWidth = spec.maxWidth;
    t.textAlign = spec.textAlign;
    if (spec.lineHeight !== undefined) t.lineHeight = spec.lineHeight;
    t.sync(() => {
      const b = t.textRenderInfo?.blockBounds;
      blocks.set(key, b ? { width: b[2] - b[0], height: b[3] - b[1] } : { width: 0, height: 0 });
      t.dispose();
      inflight.delete(key);
      version++;
      for (const cb of listeners) cb();
      resolve();
    });
  });
  inflight.set(key, job);
}

export function subscribePanelMeasures(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function panelMeasureVersion(): number {
  return version;
}

/** Export/preload barrier: every requested measurement settled (the awaitEmojiRastersIdle shape). */
export async function awaitPanelMeasuresIdle(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight.values()]);
  }
}

/** The sidecar's bullet lines (one per rendered bullet); the ONE splitter the solver and the renderer share, so measured and rendered bullets can never disagree. */
export function splitBullets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface PanelTextInput {
  text: string;
  font: string;
  /** Size at fit = 1; the solver scales it per iteration. */
  baseSize: number;
  maxWidth: number;
  textAlign: "left" | "center" | "right";
  lineHeight?: number;
}

export interface PanelLayoutSolution {
  fit: number;
  /** Actual world heights at the solved fit (already scaled; advance by them directly). */
  titleH: number;
  subH: number;
  /** Per-bullet measured heights at the solved fit, in `splitBullets` order (wrapped bullets are taller than one line). */
  bulletHeights: number[];
  /** Hanging indent at the solved fit: the marker prefix's advance, so wrapped bullet lines clear the marker. Zero under centre/right alignment (the markers ride with the text) and until the probes land. */
  bulletIndent: number;
  /** Cache misses hit along the iteration path; request these, then re-solve when they land. */
  pending: PanelTextSpec[];
}

function textInput(
  text: string,
  face: "headline" | "body",
  baseSize: number,
  maxWidth: number,
  textAlign: "left" | "center" | "right",
  theme: Theme,
  doc: SceneDoc | undefined,
  key: string,
): PanelTextInput {
  // Mirror AnimatedHeadline's sidecar dispatch for the overrides that change layout (font, size, line height), so reserved and rendered heights agree.
  const fontValue = doc?.textStyle?.[`${key}Font`];
  const sizeMul = doc?.textStyle?.[`${key}Size`];
  const lineHeight = doc?.textStyle?.[`${key}LineHeight`];
  return {
    text: prepareEmojiText(text).text,
    font: fontUrl(
      typeof fontValue === "string" ? parseFontString(fontValue) : theme.typography[face],
    ),
    baseSize: typeof sizeMul === "number" ? baseSize * sizeMul : baseSize,
    maxWidth,
    textAlign,
    ...(typeof lineHeight === "number" ? { lineHeight } : {}),
  };
}

/** Block height at `fit`: the measured cache when warm, else the wrap estimate (recording the miss). `maxWidth` overrides the input's own wrap width (the bullets wrap inside their hanging indent). */
function heightAt(
  input: PanelTextInput | null,
  fit: number,
  pending: PanelTextSpec[],
  maxWidth?: number,
): number {
  if (!input) return 0;
  const fontSize = input.baseSize * fit;
  const wrapWidth = maxWidth ?? input.maxWidth;
  const spec: PanelTextSpec = {
    text: input.text,
    font: input.font,
    fontSize,
    maxWidth: wrapWidth,
    textAlign: input.textAlign,
    ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
  };
  const measured = measuredPanelTextHeight(spec);
  if (measured !== null) return measured;
  pending.push(spec);
  const line = input.lineHeight ?? LINE_HEIGHT;
  return estimateTitleLines(input.text, fontSize, wrapWidth) * line * fontSize;
}

/** The hanging indent at `fit`: the advance of the rendered `"•  "` prefix, so an unwrapped bullet's text starts exactly where the old single-string bullet put it. Taken as marker+gap+marker less one marker, because troika drops a line's TRAILING whitespace from its measured width, which would lose the gap. Zero until both probes land (the export preamble warms them). */
function bulletIndentAt(input: PanelTextInput, fit: number, pending: PanelTextSpec[]): number {
  const base = {
    font: input.font,
    fontSize: input.baseSize * fit,
    maxWidth: Number.POSITIVE_INFINITY,
    textAlign: input.textAlign,
    ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
  };
  const prefixed: PanelTextSpec = {
    ...base,
    text: `${BULLET_MARKER}${BULLET_GAP}${BULLET_MARKER}`,
  };
  const marker: PanelTextSpec = { ...base, text: BULLET_MARKER };
  const prefixedBlock = measuredPanelTextBlock(prefixed);
  const markerBlock = measuredPanelTextBlock(marker);
  if (!prefixedBlock) pending.push(prefixed);
  if (!markerBlock) pending.push(marker);
  if (!prefixedBlock || !markerBlock) return 0;
  return Math.max(0, prefixedBlock.width - markerBlock.width);
}

/** The sidecar's size multiplier for the header icon (`textStyle.iconSize`), 1 when unset: `FrameIcon` applies it to the drawn mark, callers apply it to their stacking budget. */
export function headerIconScale(doc: SceneDoc | undefined, key = ICON_TEXT_KEY): number {
  const value = doc?.textStyle?.[`${key}Size`];
  return typeof value === "number" ? value : 1;
}

/** Solve the panel's fit-to-column fixpoint for one scene: title/subtitle heights at the candidate size feed the fit, which feeds the next candidate size, until the stack fits (or the iteration cap). Pure given a warm cache, so the live panel and the export pre-warm walk the same sequence. */
export function solvePanelLayout(
  format: FormatInfo,
  frame: FrameSpec,
  doc: SceneDoc | undefined,
  theme: Theme,
): PanelLayoutSolution {
  const col = framePanelLayout(format, frame);
  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const claimed = frame.claimsSceneText !== false;
  const specialised = usesSpecialisedTextRenderer(doc);
  const title =
    claimed && specialised
      ? resolveTemplateManagedTextCopy(doc, "title", doc?.text?.title ?? "").trim()
      : "";
  const subtitle =
    claimed && specialised
      ? resolveTemplateManagedTextCopy(doc, "subtitle", doc?.text?.subtitle ?? "").trim()
      : "";
  const bulletLines =
    claimed && specialised
      ? resolveTemplateManagedTextBullets(doc, "bullets", doc?.text?.bullets)
      : [];
  const icon = !claimed
    ? frame.icon
    : specialised
      ? resolveTemplateManagedFrameIcon(doc, frame.icon)
      : undefined;
  const iconKey = frameIconStyleKey(doc);
  const align = frameTextAlign(frame);
  const titleInput = title
    ? textInput(title, "headline", baseTitle, col.width, align, theme, doc, "title")
    : null;
  const subInput = subtitle
    ? textInput(
        subtitle,
        "body",
        baseTitle * SUBTITLE_OF_TITLE,
        col.width,
        align,
        theme,
        doc,
        "subtitle",
      )
    : null;
  // Bullets measure the exact rendered string; each wraps independently. Left-aligned bullets render the marker as its own node, so they measure the TEXT alone inside the reduced (indented) width, and centre/right keep the one-string form.
  const baseBullet = baseTitle * BULLET_OF_TITLE;
  const hanging = align === "left";
  const bulletInputs = bulletLines.map((line) =>
    textInput(
      hanging ? line : `${BULLET_MARKER}${BULLET_GAP}${line}`,
      "body",
      baseBullet,
      col.width,
      align,
      theme,
      doc,
      "bullets",
    ),
  );

  // Every non-measured block scales linearly with fit; sum them once at fit = 1.
  const iconBudget = icon
    ? baseTitle * ICON_SIZE * headerIconScale(doc, iconKey) + ICON_GAP * baseTitle
    : 0;
  const titleGap = title && subtitle ? TITLE_GAP * baseTitle : 0;
  const baseChip = CHIP_HEIGHT_FRAC * format.frame.height;
  const chipBudget = frame.chip
    ? (bulletLines.length > 0 ? CHIP_GAP * baseBullet : 0) + baseChip
    : 0;
  const fixedBudget = iconBudget + titleGap + HEADER_BODY_GAP * baseTitle + chipBudget;

  let fit = 1;
  let titleH = 0;
  let subH = 0;
  let bulletHeights: number[] = [];
  let bulletIndent = 0;
  const pending: PanelTextSpec[] = [];
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    titleH = heightAt(titleInput, fit, pending);
    subH = heightAt(subInput, fit, pending);
    const first = bulletInputs[0];
    bulletIndent = hanging && first ? bulletIndentAt(first, fit, pending) : 0;
    bulletHeights = bulletInputs.map((input) =>
      heightAt(input, fit, pending, col.width - bulletIndent),
    );
    const bulletsH =
      bulletHeights.length > 0
        ? bulletHeights.reduce((sum, h) => sum + h, 0) +
          (bulletHeights.length - 1) * BULLET_LINE_GAP * baseBullet * fit
        : 0;
    const stack = fixedBudget * fit + titleH + subH + bulletsH;
    if (stack <= col.height || stack <= 0) break;
    fit = (fit * col.height) / stack;
  }
  return { fit, titleH, subH, bulletHeights, bulletIndent, pending };
}

/** Pre-warm every overlay scene's measurements along the solver's own iteration path before frame 0 (called from the export preamble beside the emoji-raster preload). */
export async function preloadPanelMeasures(
  format: FormatInfo,
  frames: readonly (FrameSpec | undefined)[],
  docs: readonly (SceneDoc | undefined)[],
  themes: readonly (Theme | undefined)[],
): Promise<void> {
  // Each pass warms the specs the previous solve was missing; the sequence is finite (FIT_ITERATIONS keys per text).
  for (let pass = 0; pass < PRELOAD_PASSES; pass++) {
    let missing = 0;
    frames.forEach((frame, i) => {
      const theme = themes[i];
      if (!frame || !theme) return;
      const { pending } = solvePanelLayout(format, frame, docs[i], theme);
      missing += pending.length;
      for (const spec of pending) requestPanelTextMeasure(spec);
    });
    if (missing === 0) return;
    await awaitPanelMeasuresIdle();
  }
}
