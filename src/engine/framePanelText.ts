/** Pure text-budget maths for the overlay panel (FramePanel), unit-pinned like framePanelLayout: troika wraps async, so the title's vertical budget is a synchronous estimate, not a measurement. */

/** Cap on the estimated line count; titles are short by design, the fit scale absorbs the rest. */
export const TITLE_MAX_LINES = 4;

/** Per-character advance classes (em), tuned against the bundled faces and biased slightly wide, so a borderline title budgets an extra line rather than letting the body ride up into a wrapped one. */
export function charAdvance(c: string): number {
  const cp = c.codePointAt(0) ?? 0;
  // Emoji quads and CJK render close to a full em.
  if (cp > 0x3000) return 1.05;
  if (c === " ") return 0.3;
  if ("iljI.,:;'’|!".includes(c)) return 0.32;
  if ('ftr-()[]{}"'.includes(c)) return 0.45;
  if ("mwMW@%".includes(c)) return 0.9;
  if (c >= "A" && c <= "Z") return 0.7;
  if (c >= "0" && c <= "9") return 0.6;
  return 0.55;
}

function wordAdvance(word: string): number {
  let em = 0;
  for (const c of word) em += charAdvance(c);
  return em;
}

/** Estimates how many lines a title wraps to at `size` in `width` world units, so its vertical budget adapts to length. Simulates troika's greedy word-wrap (whole words per line) over per-character advances, so both "Repository Standard" and an m-heavy title budget the lines they actually take. */
export function estimateTitleLines(text: string, size: number, width: number): number {
  const lineEm = Math.max(charAdvance("m"), width / size);
  const spaceEm = charAdvance(" ");
  let lines = 1;
  let filled = 0;
  for (const word of text.trim().split(/\s+/)) {
    const em = wordAdvance(word);
    if (filled === 0) filled = em;
    else if (filled + spaceEm + em <= lineEm) filled += spaceEm + em;
    else {
      lines++;
      filled = em;
    }
  }
  return Math.min(TITLE_MAX_LINES, lines);
}
