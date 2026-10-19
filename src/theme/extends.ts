import { parseWarn } from "../engine/parseWarnings";

/** Theme variants: a v3 workspace theme may name a base with `"extends": "<theme id>"` and carry only what differs. `resolveThemeDocument` deep-merges the chain into one plain document before `parseThemeDoc` sees it: objects merge key by key, arrays and scalars replace, the child wins, and a `null` clears an inherited value. The base never lends its identity (`id`, `name`, `catalogue`, `version`). Bundled themes may not extend. Pure module; mirrored by the kit (`kblib/themes.py`) and packs (`pack/deps.rs`), all three replaying `theme-merge-vectors.json`. */

/** The first theme document version that honours `extends`; older documents load exactly as written. */
export const THEME_EXTENDS_VERSION = 3;

/** Longest chain followed before giving up, so a hand-made loop through many files still ends. */
export const MAX_THEME_CHAIN = 16;

const OWN_KEYS = new Set(["id", "name", "catalogue", "version", "extends"]);

type Doc = Record<string, unknown>;

const isRecord = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** A raw theme document by theme id (bundled id or `ws:<slug>`), or undefined when there is none. */
export type ThemeDocLookup = (id: string) => unknown;

/** The base a document names, when its version honours `extends`. */
export function themeExtendsOf(raw: unknown): string | undefined {
  if (!isRecord(raw) || typeof raw.extends !== "string" || raw.extends.trim() === "") {
    return undefined;
  }
  return typeof raw.version === "number" && raw.version >= THEME_EXTENDS_VERSION
    ? raw.extends.trim()
    : undefined;
}

function mergeRecord(base: Doc, patch: Doc): Doc {
  const out: Doc = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isRecord(value))
      out[key] = mergeRecord(isRecord(out[key]) ? (out[key] as Doc) : {}, value);
    else out[key] = value;
  }
  return out;
}

/** One level of the chain: the base's settings under the child's, the child's identity only, no `extends`. */
export function mergeThemeDocs(base: Doc, child: Doc): Doc {
  const inherited: Doc = {};
  for (const [key, value] of Object.entries(base)) if (!OWN_KEYS.has(key)) inherited[key] = value;
  const merged = mergeRecord(inherited, child);
  delete merged.extends;
  return merged;
}

/** The document `parseThemeDoc` should read: `raw` itself when it extends nothing, the merged chain when it does, undefined (with a warning naming the problem) when the chain is broken, so the caller falls back as it would for an unknown theme. */
export function resolveThemeDocument(
  raw: unknown,
  source: string,
  lookup: ThemeDocLookup,
): unknown {
  if (!isRecord(raw) || raw.extends === undefined) return raw;
  const baseId = themeExtendsOf(raw);
  if (baseId === undefined) {
    parseWarn(
      typeof raw.extends === "string" && raw.extends.trim() !== ""
        ? `[theme] ${source}: "extends" needs theme version ${THEME_EXTENDS_VERSION}, ignored`
        : `[theme] ${source}: "extends" must name a theme, ignored`,
    );
    const { extends: _ignored, ...rest } = raw;
    return rest;
  }
  const chain: Doc[] = [raw];
  const seen = [source];
  let next: string | undefined = baseId;
  while (next !== undefined) {
    if (seen.includes(next)) {
      parseWarn(
        `[theme] ${source}: "extends" loops back to "${next}" (${[...seen, next].join(" > ")}), so the theme can't load`,
      );
      return undefined;
    }
    if (chain.length > MAX_THEME_CHAIN) {
      parseWarn(
        `[theme] ${source}: "extends" chains through more than ${MAX_THEME_CHAIN} themes, so the theme can't load`,
      );
      return undefined;
    }
    const base = lookup(next);
    if (!isRecord(base)) {
      parseWarn(
        `[theme] ${source}: its base theme "${next}" can't be found, so the theme can't load`,
      );
      return undefined;
    }
    seen.push(next);
    chain.push(base);
    next = themeExtendsOf(base);
  }
  let merged = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) merged = mergeThemeDocs(merged, chain[i]);
  return merged;
}

/** Fetches every document a chain names (cycle-safe, capped) so the synchronous resolver can run over a plain map. */
export async function collectThemeChain(
  raw: unknown,
  read: (id: string) => Promise<unknown>,
): Promise<Map<string, unknown>> {
  const docs = new Map<string, unknown>();
  let next = themeExtendsOf(raw);
  while (next !== undefined && !docs.has(next) && docs.size < MAX_THEME_CHAIN) {
    let doc: unknown;
    try {
      doc = await read(next);
    } catch {
      doc = undefined;
    }
    docs.set(next, doc);
    next = themeExtendsOf(doc);
  }
  return docs;
}

/** Every theme id whose chain reaches `id`, nearest first; `docs` maps theme ids to raw documents. */
export function themeDependents(id: string, docs: ReadonlyMap<string, unknown>): string[] {
  const out: string[] = [];
  let frontier = [id];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const [candidate, doc] of docs) {
      if (candidate === id || out.includes(candidate)) continue;
      const base = themeExtendsOf(doc);
      if (base !== undefined && frontier.includes(base)) {
        out.push(candidate);
        nextFrontier.push(candidate);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

/** Maps an edit of the merged view (`before` = merge of `base` and `child`) back onto the child: changed keys land in the child, recursing into objects; removed inherited keys become `null`; keys the edit left alone keep whatever the child already said. */
export function patchThemeVariant(child: Doc, base: Doc, before: Doc, after: Doc): Doc {
  return patchLevel(child, base, before, after, true);
}

function patchLevel(child: Doc, base: Doc, before: Doc, after: Doc, top: boolean): Doc {
  const out: Doc = { ...child };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (top && key === "extends") continue;
    const was = before[key];
    const now = after[key];
    if (sameJson(was, now)) continue;
    const inherited = top && OWN_KEYS.has(key) ? undefined : base[key];
    const own = child[key];
    if (now === undefined) {
      if (inherited !== undefined) out[key] = null;
      else delete out[key];
    } else if (isRecord(now) && isRecord(was) && (isRecord(own) || own === undefined)) {
      out[key] = patchLevel(
        isRecord(own) ? own : {},
        isRecord(inherited) ? inherited : {},
        was,
        now,
        false,
      );
    } else {
      out[key] = replaceOver(inherited, now);
    }
  }
  return out;
}

/** A child value that merges over `inherited` to exactly `now`. */
function replaceOver(inherited: unknown, now: unknown): unknown {
  if (!isRecord(now) || !isRecord(inherited)) return now;
  const out: Doc = {};
  for (const [key, value] of Object.entries(now)) out[key] = replaceOver(inherited[key], value);
  for (const key of Object.keys(inherited)) if (!(key in now)) out[key] = null;
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => sameJson(a[key], b[key]));
  }
  return false;
}
