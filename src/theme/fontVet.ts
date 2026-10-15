import fontParser, { type TroikaParsedFont } from "troika-three-text/src/FontParser.js";

export interface FontVerdict {
  ok: boolean;
  error?: string;
  /** The file couldn't be read this time (never cached); the face itself was not judged. */
  transient?: boolean;
}

/** What troika exercises on every typeset: basic Latin lookups plus a glyph walk that builds paths and advances. */
const VET_CODE_POINTS = [0x41, 0x20];
const VET_TEXT = "Aa0 .";

/** Typr throws bare strings ("unknown cmap table format 6"); everything else is an Error. */
export function describeFontError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** Null when troika can typeset with the face, else why not. Only failures that would throw count: a face missing a glyph still renders (troika falls back per code point), so rejecting it would move a working project's pixels. */
export function vetParsedFont(font: TroikaParsedFont): string | null {
  if (!(font.unitsPerEm > 0)) return "the font has no usable unitsPerEm";
  if (!Number.isFinite(font.ascender) || !Number.isFinite(font.descender)) {
    return "the font has no usable ascender or descender";
  }
  for (const code of VET_CODE_POINTS) font.supportsCodePoint(code);
  font.forEachGlyph(VET_TEXT, 1, 0, () => {});
  return null;
}

/** Judges a face with troika's own parser (the Typr build and wrapper its typesetter runs), so a face that would throw inside troika's XHR callback, wedging every pending preload, is caught first. */
export async function vetFontBuffer(buffer: ArrayBuffer): Promise<FontVerdict> {
  try {
    const font = await fontParser.onMainThread(buffer);
    const problem = vetParsedFont(font);
    return problem ? { ok: false, error: problem } : { ok: true };
  } catch (e) {
    return { ok: false, error: describeFontError(e) };
  }
}

const verdicts = new Map<string, Promise<FontVerdict>>();

/** Fetch and vet one face, the parse verdict cached per URL; a failed fetch is reported but never cached, so a transient read error retries on the next load. */
export function vetFontUrl(url: string): Promise<FontVerdict> {
  const cached = verdicts.get(url);
  if (cached) return cached;
  let fetched = true;
  const pending = (async (): Promise<FontVerdict> => {
    let buffer: ArrayBuffer;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = await response.arrayBuffer();
    } catch (e) {
      fetched = false;
      return {
        ok: false,
        transient: true,
        error: `couldn't read the font file (${describeFontError(e)})`,
      };
    }
    return vetFontBuffer(buffer);
  })();
  verdicts.set(url, pending);
  void pending.then(() => {
    if (!fetched) verdicts.delete(url);
  });
  return pending;
}
