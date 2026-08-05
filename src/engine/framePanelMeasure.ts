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

const heights = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/** Measured block height in world units at the spec's size, or null until the typeset lands. */
export function measuredPanelTextHeight(spec: PanelTextSpec): number | null {
  return heights.get(specKey(spec)) ?? null;
}

/** Kick a measurement (idempotent); listeners fire when the height lands. */
export function requestPanelTextMeasure(spec: PanelTextSpec): void {
  const key = specKey(spec);
  if (heights.has(key) || inflight.has(key)) return;
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
      heights.set(key, b ? b[3] - b[1] : 0);
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
}

export interface PanelLayoutSolution {
  fit: number;
  /** Actual world heights at the solved fit (already scaled; advance by them directly). */
  titleH: number;
  subH: number;
  /** Per-bullet measured heights at the solved fit, in `splitBullets` order (wrapped bullets are taller than one line). */
  bulletHeights: number[];
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
  // Mirror AnimatedHeadline's sidecar dispatch for the overrides that change layout (font + size), so reserved and rendered heights agree.
  const fontValue = doc?.textStyle?.[`${key}Font`];
  const sizeMul = doc?.textStyle?.[`${key}Size`];
  return {
    text: prepareEmojiText(text).text,
    font: fontUrl(
      typeof fontValue === "string" ? parseFontString(fontValue) : theme.typography[face],
    ),
    baseSize: typeof sizeMul === "number" ? baseSize * sizeMul : baseSize,
    maxWidth,
    textAlign,
  };
}

/** Block height at `fit`: the measured cache when warm, else the wrap estimate (recording the miss). */
function heightAt(input: PanelTextInput | null, fit: number, pending: PanelTextSpec[]): number {
  if (!input) return 0;
  const fontSize = input.baseSize * fit;
  const spec: PanelTextSpec = {
    text: input.text,
    font: input.font,
    fontSize,
    maxWidth: input.maxWidth,
    textAlign: input.textAlign,
  };
  const measured = measuredPanelTextHeight(spec);
  if (measured !== null) return measured;
  pending.push(spec);
  return estimateTitleLines(input.text, fontSize, input.maxWidth) * LINE_HEIGHT * fontSize;
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
  const title = claimed ? (doc?.text?.title ?? "").trim() : "";
  const subtitle = claimed ? (doc?.text?.subtitle ?? "").trim() : "";
  const bulletLines = claimed ? splitBullets(doc?.text?.bullets) : [];
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
  // Bullets measure the exact rendered string (the leading marker changes wrapping); each wraps independently.
  const baseBullet = baseTitle * BULLET_OF_TITLE;
  const bulletInputs = bulletLines.map((line) =>
    textInput(`•  ${line}`, "body", baseBullet, col.width, align, theme, doc, "bullets"),
  );

  // Every non-measured block scales linearly with fit; sum them once at fit = 1.
  const iconBudget = frame.icon ? baseTitle * ICON_SIZE + ICON_GAP * baseTitle : 0;
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
  const pending: PanelTextSpec[] = [];
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    titleH = heightAt(titleInput, fit, pending);
    subH = heightAt(subInput, fit, pending);
    bulletHeights = bulletInputs.map((input) => heightAt(input, fit, pending));
    const bulletsH =
      bulletHeights.length > 0
        ? bulletHeights.reduce((sum, h) => sum + h, 0) +
          (bulletHeights.length - 1) * BULLET_LINE_GAP * baseBullet * fit
        : 0;
    const stack = fixedBudget * fit + titleH + subH + bulletsH;
    if (stack <= col.height || stack <= 0) break;
    fit = (fit * col.height) / stack;
  }
  return { fit, titleH, subH, bulletHeights, pending };
}

/** Pre-warm every overlay scene's measurements along the solver's own iteration path before frame 0 (called from the export preamble beside the emoji-raster preload). */
export async function preloadPanelMeasures(
  format: FormatInfo,
  frames: readonly (FrameSpec | undefined)[],
  docs: readonly (SceneDoc | undefined)[],
  themes: readonly (Theme | undefined)[],
): Promise<void> {
  // Each pass warms the specs the previous solve was missing; the sequence is finite (FIT_ITERATIONS keys per text).
  for (let pass = 0; pass < FIT_ITERATIONS + 1; pass++) {
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
