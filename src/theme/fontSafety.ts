import type { FontIssue } from "../engine/loadDiagnostics";
import { ensureFontRefsPinned } from "../engine/systemFonts";
import { parseFontString } from "./fontRef";
import {
  fontSubstituteRef,
  interFallbackRef,
  isBundledFamily,
  resolvedFontUrl,
  setFontSubstitute,
} from "./fonts";
import { type FontVerdict, vetFontUrl } from "./fontVet";
import type { FontRef } from "./tokens";

export interface FontRefVerdict {
  ref: string;
  ok: boolean;
  error?: string;
  fallback?: string | null;
}

const refString = (ref: FontRef): string => `${ref.family}@${ref.weight}`;
const refKey = (ref: FontRef): string => `${ref.family}:${ref.weight}`;

const NOT_INSTALLED = (family: string) =>
  `"${family}" isn't bundled and couldn't be found in the workspace fonts or installed on this Mac`;

/** The nearest-weight face of the theme that is itself safe and not the rejected face, else Inter. */
function pickFallback(
  ref: FontRef,
  url: string,
  themeFaces: readonly FontRef[],
  verdictFor: (url: string) => FontVerdict | undefined,
): FontRef {
  let best: FontRef | null = null;
  for (const face of themeFaces) {
    const faceUrl = resolvedFontUrl(face);
    if (!faceUrl || faceUrl === url) continue;
    if (!isBundledFamily(face.family) && !verdictFor(faceUrl)?.ok) continue;
    if (!best || Math.abs(face.weight - ref.weight) < Math.abs(best.weight - ref.weight)) {
      best = face;
    }
  }
  return best ?? interFallbackRef(ref.weight);
}

/** Vets every non-bundled face a project renders (already pinned by `ensureFontRefsPinned`), swaps each failing face for the theme's nearest-weight safe face (or Inter), and names each one. Healthy faces are untouched, so a working project renders exactly as before. */
export async function vetProjectFonts(
  refs: readonly FontRef[],
  themeFaces: readonly FontRef[],
): Promise<FontIssue[]> {
  const unique = new Map<string, FontRef>();
  for (const ref of [...refs, ...themeFaces]) unique.set(refKey(ref), ref);
  const verdicts = new Map<string, FontVerdict>();
  for (const ref of unique.values()) {
    if (isBundledFamily(ref.family)) continue;
    const url = resolvedFontUrl(ref);
    if (url && !verdicts.has(url)) verdicts.set(url, await vetFontUrl(url));
  }
  const issues: FontIssue[] = [];
  const reported = new Set<string>();
  for (const ref of refs) {
    if (isBundledFamily(ref.family) || reported.has(refKey(ref))) continue;
    reported.add(refKey(ref));
    const url = resolvedFontUrl(ref);
    if (!url) {
      issues.push({
        ref: refString(ref),
        message: NOT_INSTALLED(ref.family),
        fallback: refString(interFallbackRef(400)),
      });
      continue;
    }
    const verdict = verdicts.get(url);
    if (!verdict || verdict.ok) {
      setFontSubstitute(url, null);
      continue;
    }
    const fallback = pickFallback(ref, url, themeFaces, (u) => verdicts.get(u));
    setFontSubstitute(url, fallback);
    issues.push({
      ref: refString(ref),
      message: verdict.error ?? "troika can't typeset this face",
      fallback: refString(fallback),
      ...(verdict.transient ? { transient: true } : {}),
    });
  }
  return issues;
}

/** Checks "Family@weight" refs with troika's real parser, pinning system faces first (a pin copies the face into the workspace fonts folder, exactly what referencing it from a project would do). Bundled families always pass. */
export async function validateFontRefs(
  refs: string[],
): Promise<{ ref: string; ok: boolean; error?: string; fallback?: string | null }[]> {
  const parsed = refs.map((raw) => ({ raw, ref: parseFontString(raw.trim()) }));
  const system = parsed.map((p) => p.ref).filter((ref) => !isBundledFamily(ref.family));
  if (system.length > 0) await ensureFontRefsPinned(system);
  const results: FontRefVerdict[] = [];
  for (const { raw, ref } of parsed) {
    if (isBundledFamily(ref.family)) {
      results.push({ ref: raw, ok: true });
      continue;
    }
    const url = resolvedFontUrl(ref);
    if (!url) {
      results.push({
        ref: raw,
        ok: false,
        error: NOT_INSTALLED(ref.family),
        fallback: refString(interFallbackRef(400)),
      });
      continue;
    }
    const verdict = await vetFontUrl(url);
    if (verdict.ok) {
      results.push({ ref: raw, ok: true });
      continue;
    }
    const fallback = fontSubstituteRef(url) ?? interFallbackRef(ref.weight);
    results.push({ ref: raw, ok: false, error: verdict.error, fallback: refString(fallback) });
  }
  return results;
}
