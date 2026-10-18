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

/** The world-size block an `AnimatedHeadline` with this `textKey`, text and options typesets (sidecar Font, Size and LineHeight overrides included), or null while its face is still parsing. Captures wait for it, so exported frames always see the measured layout. */
export function useTextMetrics(
  key: string | undefined,
  text: string,
  opts: TextMetricsOptions = {},
): TextMetrics | null {
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
  return metrics;
}
