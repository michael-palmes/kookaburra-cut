/** Mirrors `src-tauri/src/pack/model.rs`. Changing a shape here without changing it there is a silent wire break. */

export const PACK_FORMAT = "kookaburra-pack";
export const PACK_FORMAT_VERSION = 1;

export type ItemKind =
  | "project"
  | "theme"
  | "font"
  | "object"
  | "gradient"
  | "exportPreset"
  | "screenshot";

/** Rail order, which is not apply order: this is what reads best to a human. */
export const ITEM_KINDS: ItemKind[] = [
  "project",
  "theme",
  "font",
  "object",
  "gradient",
  "exportPreset",
  "screenshot",
];

export const KIND_LABELS: Record<ItemKind, { one: string; many: string }> = {
  project: { one: "Project", many: "Projects" },
  theme: { one: "Theme", many: "Themes" },
  font: { one: "Font", many: "Fonts" },
  object: { one: "3D object", many: "3D objects" },
  gradient: { one: "Gradient", many: "Gradients" },
  exportPreset: { one: "Export preset", many: "Export presets" },
  screenshot: { one: "Screenshot", many: "Screenshots" },
};

// One source of truth: the union lives with the copy that explains it.
import type { FontEmbedding } from "../ui/packs/fontCopy";

export type { FontEmbedding };

export interface PackItemBase {
  slug: string;
  name: string;
  bytes: number;
  modifiedAt: string;
  contentHash: string;
}

export interface PackRequires {
  themes: string[];
  fonts: string[];
  objects: string[];
  gradients: string[];
}

export interface PackProject extends PackItemBase {
  root: string;
  manifestVersion: number;
  sceneCount: number;
  sceneFiles: string[];
  durationMs: number;
  formats: string[];
  themeId: string;
  requires: PackRequires;
  hasSceneCode: boolean;
}

export interface PackTheme extends PackItemBase {
  mode: "light" | "dark";
  docVersion: number;
  swatches: string[];
  requires: PackRequires;
}

export interface PackFont extends PackItemBase {
  family: string;
  weight: number;
  postscript: string;
  file?: string;
  sha256?: string;
  instanced?: { axes: Record<string, number>; instancer: string };
  embedding: FontEmbedding;
  referenceOnly?: boolean;
}

export interface PackObject extends PackItemBase {
  glb: string;
  thumbnail?: string;
  licence?: string;
  tags: string[];
}

export interface PackScreenshot extends PackItemBase {
  file: string;
  width?: number;
  height?: number;
}

export interface PackContents {
  projects: PackProject[];
  themes: PackTheme[];
  fonts: PackFont[];
  objects: PackObject[];
  gradients: PackItemBase[];
  exportPresets: PackItemBase[];
  screenshots: PackScreenshot[];
}

export interface PackPublisher {
  name: string;
  organisation?: string;
  website?: string;
  device: string;
  publicKey: string;
  keyId: string;
}

export interface PackManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  minAppVersion: string;
  pack: { name: string; description?: string; createdAt: string };
  publisher: PackPublisher;
  contents: PackContents;
  files: { path: string; sha256: string; bytes: number }[];
  totals: { files: number; bytes: number };
}

export type SignatureVerdict = "valid" | "invalid" | "missing";

export type PublisherVerdict =
  | { kind: "firstTime" }
  | { kind: "known"; lastPack: string; firstSeen: string; packCount: number }
  | { kind: "nameChanged"; previous: string };

export type CompatibilityVerdict = { kind: "ok" } | { kind: "needsNewerApp"; min: string };

export interface PackInspection {
  manifest: PackManifest;
  signature: SignatureVerdict;
  publisher: PublisherVerdict;
  compatibility: CompatibilityVerdict;
  archiveBytes: number;
  installBytes: number;
}

export type ConflictState = "new" | "identical" | "theirs-newer" | "yours-newer" | "unknown-age";

export type Resolution = "skip" | "replace" | "keep-both";

export interface LocalItem {
  name: string;
  modifiedAt: string;
  bytes: number;
}

export interface ItemPlan {
  kind: ItemKind;
  slug: string;
  name: string;
  state: ConflictState;
  defaultResolution: Resolution;
  resolution: Resolution;
  local?: LocalItem;
  keepBothSlug?: string;
}

export interface ImportPlan {
  items: ItemPlan[];
}

export type ItemOutcome = "added" | "replaced" | "skipped" | "keptBoth" | "failed";

export interface ImportOutcome {
  results: { kind: ItemKind; slug: string; name: string; outcome: ItemOutcome; detail?: string }[];
  backupDir?: string;
  /// Set when a partial apply stopped early: names what did and did not land.
  stoppedAt?: string;
  notes: string[];
}

/** One entry in the export picker, flattened across kinds so the list renders uniformly. */
export interface SelectableItem {
  kind: ItemKind;
  slug: string;
  name: string;
  bytes: number;
  detail?: string;
  /** Non-empty when the item was pulled in by something else the user ticked. */
  requiredBy: string[];
  /** Fonts only. */
  embedding?: FontEmbedding;
  referenceOnly?: boolean;
}

export interface UnreferencedGroup {
  projectSlug: string;
  label: string;
  files: { rel: string; bytes: number }[];
}

export interface PackPlan {
  items: SelectableItem[];
  unreferenced: UnreferencedGroup[];
  warnings: string[];
  totalBytes: number;
  fileCount: number;
}

export interface PublisherProfileView {
  name: string;
  organisation?: string;
  website?: string;
  /** Resolved values, OS-derived when the profile is unset. */
  effectiveName: string;
  device: string;
  keyId: string;
  publicKey: string;
  configured: boolean;
}

export interface PackProgress {
  file: number;
  total: number;
  bytes: number;
  totalBytes: number;
  stage: "hashing" | "writing" | "unpacking" | "verifying" | "applying";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatKeyId(keyId: string): string {
  return (keyId.match(/.{1,4}/g) ?? [keyId]).join(" ");
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}
