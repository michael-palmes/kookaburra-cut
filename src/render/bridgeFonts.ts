import { invoke } from "@tauri-apps/api/core";
import { validateFontRefs } from "../theme/fontSafety";
import { BUNDLED_FONTS } from "../theme/fonts";

export interface FontFamilyListing {
  family: string;
  weights: number[];
  bundled: boolean;
}

interface SystemFace {
  family: string;
  weight: number;
  italic: boolean;
}

/** Bundled families first, then every installed upright family (the font picker's own enumeration); a failed enumeration lists the bundled set alone. */
export async function listFontFamilies(): Promise<FontFamilyListing[]> {
  const bundled = Object.entries(BUNDLED_FONTS).map(([family, weights]) => ({
    family,
    weights: Object.keys(weights)
      .map(Number)
      .sort((a, b) => a - b),
    bundled: true,
  }));
  let system: SystemFace[] = [];
  try {
    system = await invoke<SystemFace[]>("list_system_fonts");
  } catch (e) {
    console.warn("[bridge] system font enumeration failed:", e);
  }
  const byFamily = new Map<string, Set<number>>();
  for (const face of system) {
    if (face.italic || face.family in BUNDLED_FONTS) continue;
    const weights = byFamily.get(face.family) ?? new Set<number>();
    weights.add(face.weight);
    byFamily.set(face.family, weights);
  }
  const installed = [...byFamily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, weights]) => ({
      family,
      weights: [...weights].sort((a, b) => a - b),
      bundled: false,
    }));
  return [...bundled, ...installed];
}

/** The bridge `fonts` request: troika's real parser over each ref, plus the family list on request. */
export async function serveFontsRequest(request: {
  refs?: string[];
  listFamilies?: boolean;
}): Promise<Record<string, unknown>> {
  const refs = (request.refs ?? []).filter((ref) => typeof ref === "string" && ref.trim());
  const results = await validateFontRefs(refs);
  if (!request.listFamilies) return { ok: true, results };
  return { ok: true, results, families: await listFontFamilies() };
}
