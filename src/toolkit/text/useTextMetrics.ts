import { useContext, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { SceneDocContext } from "../../engine/sceneContext";
import { reportTextDerivedPending } from "../../engine/textDerivedState";
import { useTheme } from "../../theme";
import {
  fontMetricsFailed,
  fontMetricsVersion,
  measureText,
  preloadFontMetrics,
  subscribeFontMetrics,
  type TextMetrics,
} from "../../theme/fontMetrics";
import type { FontRef } from "../../theme/tokens";
import { resolveHeadlineType } from "./headlineType";

/** The AnimatedHeadline props that shape the measured block; pass the same values the headline gets. */
export interface TextMetricsOptions {
  fontSize?: number;
  face?: "headline" | "body";
  fontRef?: FontRef;
  lineHeight?: number;
  letterSpacing?: number;
  styleKey?: string;
}

/** The size that fits a block measured at `fontSize` inside `maxWidth`: never above `fontSize` itself, and `fontSize` untouched when there is nothing to fit. */
export function fitFontSize(metrics: TextMetrics, fontSize: number, maxWidth: number): number {
  if (!(metrics.width > 0) || !(maxWidth > 0) || metrics.width <= maxWidth) return fontSize;
  return (fontSize * maxWidth) / metrics.width;
}

/** A measured block, plus the size that makes it fit a width. */
export interface MeasuredText extends TextMetrics {
  /** The `fontSize` to pass (at most the one you measured with) so the block fits `maxWidth`, sidecar Size override included. */
  fitFontSize(maxWidth: number): number;
}

/** The world-size block an `AnimatedHeadline` with this `textKey`, text and options typesets (sidecar Font, Size and LineHeight overrides included), or null until its face has loaded and it has measured real ink: never a 0-wide first measure, so a scene can divide by `width` once it has one. Captures wait for it, so exported frames always see the measured layout. */
export function useTextMetrics(
  key: string | undefined,
  text: string,
  opts: TextMetricsOptions = {},
): MeasuredText | null {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  useSyncExternalStore(subscribeFontMetrics, fontMetricsVersion, fontMetricsVersion);
  const type = resolveHeadlineType(theme, doc, { ...opts, textKey: key });
  const metrics = measureText(text, {
    font: type.fontRef,
    fontSize: type.fontSize,
    letterSpacing: opts.letterSpacing,
    lineHeight: type.lineHeight,
  });
  const pending = metrics === null && !fontMetricsFailed(type.font);
  useEffect(() => {
    if (pending) void preloadFontMetrics([type.font]);
  }, [pending, type.font]);
  useLayoutEffect(() => (pending ? reportTextDerivedPending() : undefined), [pending]);
  return measuredText(metrics, text, opts.fontSize ?? 0.6);
}

/** A measure a scene can use: null for none, or for a 0-wide block of copy that has ink coming (what a divide-by-width blows up on); blank copy is honestly 0 wide. */
export function measuredText(
  metrics: TextMetrics | null,
  text: string,
  fontSize: number,
): MeasuredText | null {
  if (metrics === null || (!(metrics.width > 0) && text.trim() !== "")) return null;
  return {
    ...metrics,
    fitFontSize: (maxWidth) => fitFontSize(metrics, fontSize, maxWidth),
  };
}
