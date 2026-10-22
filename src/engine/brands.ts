import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { MediaMeta } from "./media";

/** Workspace brands over the native module (src-tauri/src/brands.rs): `~/Kookaburra Cut/brands/<slug>/`, applied per project as `project.json` `brand`. UI-only: the export path never reads this module. */

export const BRAND_ID_PREFIX = "ws:";

export interface BrandColour {
  name: string;
  hex: string;
  role?: string;
  note?: string;
}

export interface BrandFont {
  family: string;
  weight?: number;
}

export interface BrandSummary {
  slug: string;
  /** `ws:<slug>`, the value a project's `brand` key holds. */
  id: string;
  name: string;
  description?: string;
  themes: string[];
  defaultTheme?: string;
  typography: { headline?: string; body?: string };
  colors: BrandColour[];
  gradients: string[];
  fonts: BrandFont[];
  hasGuidelines: boolean;
  /** Whether `images/` holds at least one listable image. */
  hasImages: boolean;
}

export interface BrandImage {
  /** Absolute path, for previews and copy-on-use imports. */
  path: string;
  /** Relative to the brand's `images/`. */
  rel: string;
  /** The first folder under `images/`; empty for a loose file. */
  category: string;
  name: string;
  bytes: number;
  modifiedMs: number;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const optString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** One IPC summary, defensively shaped: a malformed entry is dropped, a malformed field defaults. */
export function normaliseBrand(raw: unknown): BrandSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = optString(r.slug);
  const name = optString(r.name);
  if (!slug || !name) return null;
  const typography = (r.typography && typeof r.typography === "object" ? r.typography : {}) as {
    headline?: unknown;
    body?: unknown;
  };
  const colors = Array.isArray(r.colors)
    ? r.colors.flatMap((c): BrandColour[] => {
        const entry = (c ?? {}) as Record<string, unknown>;
        const hex = optString(entry.hex);
        if (!hex) return [];
        return [
          {
            name: optString(entry.name) ?? hex,
            hex,
            role: optString(entry.role),
            note: optString(entry.note),
          },
        ];
      })
    : [];
  const fonts = Array.isArray(r.fonts)
    ? r.fonts.flatMap((f): BrandFont[] => {
        const entry = (f ?? {}) as Record<string, unknown>;
        const family = optString(entry.family);
        if (!family) return [];
        return [{ family, weight: typeof entry.weight === "number" ? entry.weight : undefined }];
      })
    : [];
  return {
    slug,
    id: optString(r.id) ?? `${BRAND_ID_PREFIX}${slug}`,
    name,
    description: optString(r.description),
    themes: strings(r.themes),
    defaultTheme: optString(r.defaultTheme),
    typography: {
      headline: optString(typography.headline),
      body: optString(typography.body),
    },
    colors,
    gradients: strings(r.gradients),
    fonts,
    hasGuidelines: r.hasGuidelines === true,
    hasImages: r.hasImages === true,
  };
}

/** Every workspace brand, sorted by name; also refreshes the open project's cached brand. */
export async function listBrands(): Promise<BrandSummary[]> {
  const raw = await invoke<unknown[]>("list_brands");
  const brands = (Array.isArray(raw) ? raw : [])
    .map(normaliseBrand)
    .filter((b): b is BrandSummary => b !== null);
  if (active?.brandId) {
    const fresh = brands.find((b) => b.id === active?.brandId) ?? null;
    if (JSON.stringify(fresh) !== JSON.stringify(active.brand))
      publish({ ...active, brand: fresh });
  }
  return brands;
}

export function listBrandImages(slug: string): Promise<BrandImage[]> {
  return invoke<BrandImage[]>("list_brand_images", { slug });
}

/** Card metadata + a cached poster for one brand image (never the multi-MB original). */
export function brandImageMeta(slug: string, rel: string): Promise<MediaMeta> {
  return invoke<MediaMeta>("brand_image_meta", { slug, rel });
}

/** Apply (`ws:<slug>`) or clear (null) a project's brand: theme, headline/body fonts and BRAND.md follow. */
export function setProjectBrand(slug: string, brand: string | null): Promise<void> {
  return invoke("set_project_brand", { slug, brand });
}

/** Category chip label: "product" reads "Product"; a loose file's empty category reads "Other". */
export function brandCategoryLabel(category: string): string {
  const words = category.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/** The categories present, in listing order (already sorted by category). */
export function brandCategories(images: readonly BrandImage[]): string[] {
  const seen: string[] = [];
  for (const image of images) if (!seen.includes(image.category)) seen.push(image.category);
  return seen;
}

/** The open project's brand: set by App per project, read by the colour picker and the media Library. */
interface ActiveBrand {
  projectSlug: string;
  brandId: string | undefined;
  brand: BrandSummary | null;
}

let active: ActiveBrand | null = null;
let resolveSeq = 0;
const listeners = new Set<() => void>();

function publish(next: ActiveBrand | null): void {
  active = next;
  for (const listener of listeners) listener();
}

/** Bind the open project (native slug) and its manifest `brand`; resolves the summary once per change. */
export function setActiveProjectBrand(
  projectSlug: string | null,
  brandId: string | undefined,
): void {
  if (!projectSlug) {
    resolveSeq += 1;
    if (active) publish(null);
    return;
  }
  if (active && active.projectSlug === projectSlug && active.brandId === brandId) return;
  const seq = ++resolveSeq;
  publish({ projectSlug, brandId, brand: null });
  if (!brandId) return;
  void listBrands()
    .then((brands) => {
      if (seq !== resolveSeq) return;
      publish({ projectSlug, brandId, brand: brands.find((b) => b.id === brandId) ?? null });
    })
    .catch((e) => console.warn("[brands] listing failed:", e));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => active;

/** The brand for this project slug when it is the open project, else null. */
export function useProjectBrand(projectSlug: string | undefined): BrandSummary | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!projectSlug || !current || current.projectSlug !== projectSlug) return null;
  return current.brand;
}

/** The open project's brand colours, for the colour picker's Brand section. */
export function activeBrandColours(): BrandColour[] {
  return active?.brand?.colors ?? NO_COLOURS;
}

const NO_COLOURS: BrandColour[] = [];

/** `activeBrandColours` as a subscription, so a brand that resolves after the picker opens still shows. */
export function useActiveBrandColours(): BrandColour[] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return current?.brand?.colors ?? NO_COLOURS;
}
