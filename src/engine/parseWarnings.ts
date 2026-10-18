/** Parse-time warnings: the theme, scene-doc and project parsers report what they drop through `parseWarn`, a load collects them around a synchronous parse with `collectParseWarnings`, and outside a collector they reach the console exactly as before. Pure module (no React, no IO). */

let sink: string[] | null = null;

export function parseWarn(message: string): void {
  if (sink) sink.push(message);
  else console.warn(message);
}

/** Runs `fn` and returns its result with every warning raised inside it; synchronous only, since a parser awaiting would leak its warnings to whatever runs in between. */
export function collectParseWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const previous = sink;
  const warnings: string[] = [];
  sink = warnings;
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error("collectParseWarnings takes a synchronous parse");
    }
    return { result, warnings };
  } finally {
    sink = previous;
  }
}

/** `collectParseWarnings` into an optional list: without one the parse runs uncollected, so its warnings reach the console. */
export function parseInto<T>(warnings: string[] | undefined, fn: () => T): T {
  if (!warnings) return fn();
  const collected = collectParseWarnings(fn);
  warnings.push(...collected.warnings);
  return collected.result;
}

/** A parser message without its `[tag]` and its source (any lead-in ending in `source` before the first ": "), ready to sit after a file name. */
export function cleanParseWarning(message: string, source?: string): string {
  let out = message.replace(/^\[[^\]]+\]\s*/, "");
  const at = source ? out.indexOf(source) : -1;
  const colon = out.indexOf(": ");
  if (source && at >= 0 && (colon < 0 || at < colon)) {
    out = out.slice(at + source.length).replace(/^:?\s*/, "");
  }
  return out.trim();
}

export const MAX_LOAD_WARNINGS = 40;

/** Unique warnings in first-seen order, capped with a closing count of what was left out. */
export function capWarnings(warnings: readonly string[], max = MAX_LOAD_WARNINGS): string[] {
  const unique = [...new Set(warnings)];
  if (unique.length <= max) return unique;
  const more = unique.length - (max - 1);
  return [...unique.slice(0, max - 1), `and ${more} more settings were ignored`];
}
