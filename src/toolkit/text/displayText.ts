import { type PreparedEmojiText, prepareEmojiTextMapped } from "./emojiText";

/** Display text: sidecar copy marks emphasised words with `*word*` (markdown's flanking rules, always on), stripped here before anything measures or typesets, so layout never sees the asterisks. Pure and deterministic. */

/** Half-open [start, end) code-unit ranges into the typeset text. */
export type EmphasisRange = readonly [number, number];

export interface PreparedDisplayText extends PreparedEmojiText {
  /** Emphasised ranges in `text` code units, in order; empty when the copy has no markup. */
  emphasis: readonly EmphasisRange[];
}

interface Delimiter {
  /** Code-unit index of the run's first `*`. */
  pos: number;
  /** Unmatched `*` left in the run (an opener consumes from its end, a closer from its start). */
  remaining: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  /** Consumed from the run's end (as an opener) and start (as a closer). */
  usedEnd: number;
  usedStart: number;
}

const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;

function charClass(ch: string | undefined): "space" | "punct" | "other" {
  if (ch === undefined || WHITESPACE.test(ch)) return "space";
  return PUNCTUATION.test(ch) ? "punct" : "other";
}

/** The code point ending just before `i` (surrogate-aware), undefined at the start. */
function codePointBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function codePointAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** The keycap emoji (`*` + VS16 + U+20E3) is never markup. */
function isKeycap(s: string, i: number): boolean {
  const next = s.charCodeAt(i + 1);
  return next === 0xfe0f || next === 0x20e3;
}

/** Delimiter runs of one paragraph, flanking computed per CommonMark (beginning and end of text count as whitespace; symbols count as punctuation). */
function delimiterRuns(s: string, start: number, end: number): Delimiter[] {
  const runs: Delimiter[] = [];
  let i = start;
  while (i < end) {
    if (s[i] !== "*" || isKeycap(s, i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && s[j] === "*" && !isKeycap(s, j)) j++;
    const before = charClass(i === start ? undefined : codePointBefore(s, i));
    const after = charClass(j === end ? undefined : codePointAt(s, j));
    const left = after !== "space" && (after !== "punct" || before !== "other");
    const right = before !== "space" && (before !== "punct" || after !== "other");
    const length = j - i;
    runs.push({
      pos: i,
      remaining: length,
      length,
      canOpen: left,
      canClose: right,
      usedEnd: 0,
      usedStart: 0,
    });
    i = j;
  }
  return runs;
}

/** CommonMark's "process emphasis" over `*` runs (nearest opener, the rule of three); every match, single or double, is one emphasis. Returns the emphasised [start, end) spans in raw indices; the consumed asterisks are recorded on the runs. */
function matchRuns(runs: Delimiter[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const alive = runs.map(() => true);
  for (let c = 0; c < runs.length; c++) {
    const closer = runs[c];
    if (!closer.canClose) continue;
    while (closer.remaining > 0) {
      let found = -1;
      for (let o = c - 1; o >= 0; o--) {
        const opener = runs[o];
        if (!alive[o] || !opener.canOpen || opener.remaining <= 0) continue;
        const both = opener.canClose || closer.canOpen;
        const sum = opener.length + closer.length;
        if (both && sum % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0)) {
          continue;
        }
        found = o;
        break;
      }
      if (found < 0) break;
      const opener = runs[found];
      const n = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
      opener.remaining -= n;
      opener.usedEnd += n;
      closer.remaining -= n;
      closer.usedStart += n;
      spans.push([
        opener.pos + opener.length - opener.usedEnd + n,
        closer.pos + closer.usedStart - n,
      ]);
      for (let k = found + 1; k < c; k++) alive[k] = false;
      if (opener.remaining <= 0) alive[found] = false;
    }
    if (closer.remaining <= 0) alive[c] = false;
  }
  return spans;
}

/** Strip `*word*` emphasis markup: returns the display text and the emphasised ranges in its code units. A lone `*`, `5 * 3` or an asterisk beside a space stays literal; emphasis never crosses a blank line. */
export function parseEmphasisMarkup(raw: string): { text: string; ranges: EmphasisRange[] } {
  if (!raw.includes("*")) return { text: raw, ranges: [] };
  const removed = new Uint8Array(raw.length);
  const rawSpans: Array<[number, number]> = [];
  const breaks = /\n[ \t]*\n/g;
  let start = 0;
  const paragraphs: Array<[number, number]> = [];
  for (let m = breaks.exec(raw); m; m = breaks.exec(raw)) {
    paragraphs.push([start, m.index]);
    start = m.index + m[0].length;
  }
  paragraphs.push([start, raw.length]);
  for (const [a, b] of paragraphs) {
    const runs = delimiterRuns(raw, a, b);
    if (runs.length < 2) continue;
    for (const span of matchRuns(runs)) rawSpans.push(span);
    for (const run of runs) {
      for (let k = 0; k < run.usedStart; k++) removed[run.pos + k] = 1;
      for (let k = 0; k < run.usedEnd; k++) removed[run.pos + run.length - 1 - k] = 1;
    }
  }
  if (rawSpans.length === 0) return { text: raw, ranges: [] };
  const map = new Int32Array(raw.length + 1);
  let text = "";
  for (let i = 0; i < raw.length; i++) {
    map[i] = text.length;
    if (!removed[i]) text += raw[i];
  }
  map[raw.length] = text.length;
  return { text, ranges: mergeRanges(rawSpans.map(([s, e]) => [map[s], map[e]] as const)) };
}

/** Sorted, non-empty, non-overlapping ranges (nested emphasis unions). */
function mergeRanges(ranges: readonly EmphasisRange[]): EmphasisRange[] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The one text preparation every typesetting and measuring path shares: emphasis markup stripped, then emoji swapped for placeholders (`prepareEmojiText`), with the emphasised ranges carried into the final string's code units. Copy without markup returns exactly what `prepareEmojiText` returns, plus an empty `emphasis`. */
export function prepareDisplayText(raw: string): PreparedDisplayText {
  const { text: stripped, ranges } = parseEmphasisMarkup(raw);
  const prepared = prepareEmojiTextMapped(stripped);
  if (ranges.length === 0)
    return { text: prepared.text, clusters: prepared.clusters, emphasis: [] };
  const map = prepared.map;
  const emphasis = map
    ? mergeRanges(ranges.map(([s, e]) => [map[s], map[e]] as const))
    : ranges.slice();
  return { text: prepared.text, clusters: prepared.clusters, emphasis };
}
