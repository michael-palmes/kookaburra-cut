/** The frontend seam for `.kbpack` export and import: typed wrappers over the Rust commands, plus the Save dialog. Every filesystem touch stays in Rust behind a path-confined command. */

import { Channel, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type {
  ImportOutcome,
  ImportPlan,
  ItemKind,
  PackInspection,
  PackPlan,
  PackProgress,
  PackSceneDoc,
  Resolution,
  SceneSource,
} from "../packs/types";
import { notePickedFolder } from "./pickedFolders";

export interface PackSelection {
  projects: string[];
  templates: string[];
  presets: string[];
  themes: string[];
  brands: string[];
  fonts: string[];
  objects: string[];
  gradients: string[];
  exportPresets: string[];
  screenshots: string[];
  /** Project-relative asset paths the user chose to drop, keyed by project slug. */
  dropAssets?: Record<string, string[]>;
}

export const EMPTY_SELECTION: PackSelection = {
  projects: [],
  templates: [],
  presets: [],
  themes: [],
  brands: [],
  fonts: [],
  objects: [],
  gradients: [],
  exportPresets: [],
  screenshots: [],
};

export function selectionKey(kind: ItemKind): keyof PackSelection {
  switch (kind) {
    case "project":
      return "projects";
    case "template":
      return "templates";
    case "preset":
      return "presets";
    case "theme":
      return "themes";
    case "brand":
      return "brands";
    case "font":
      return "fonts";
    case "object":
      return "objects";
    case "gradient":
      return "gradients";
    case "exportPreset":
      return "exportPresets";
    case "screenshot":
      return "screenshots";
  }
}

export function selectionCount(selection: PackSelection): number {
  return (
    selection.projects.length +
    selection.templates.length +
    selection.presets.length +
    selection.themes.length +
    selection.brands.length +
    selection.fonts.length +
    selection.objects.length +
    selection.gradients.length +
    selection.exportPresets.length +
    selection.screenshots.length
  );
}

/** Everything the export picker can offer, before anything is selected. */
export function listPackables(): Promise<PackPlan> {
  return invoke<PackPlan>("list_packables");
}

/** Re-resolve the closure for a selection. Pure read, safe to call on every tick. */
export function planPack(selection: PackSelection): Promise<PackPlan> {
  return invoke<PackPlan>("plan_pack", { selection });
}

export interface PackMetaInput {
  name: string;
  description?: string;
  /** The publisher name for an install with no saved profile; ignored once one exists. */
  publisherName?: string;
  /** Save `publisherName` as the profile, so the window asks once. */
  rememberPublisher?: boolean;
}

/** The app's first Save dialog. The path is user-chosen through a native OS surface, and Rust re-validates it before writing. */
export async function chooseDestination(defaultName: string): Promise<string | null> {
  const path = await save({
    title: "Export Pack",
    defaultPath: `${defaultName}.kbpack`,
    filters: [{ name: "Kookaburra Pack", extensions: ["kbpack"] }],
  });
  await notePickedFolder(path);
  return path ?? null;
}

export function buildPack(
  selection: PackSelection,
  destination: string,
  meta: PackMetaInput,
  onProgress?: (p: PackProgress) => void,
): Promise<{ path: string; bytes: number }> {
  const channel = new Channel<PackProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke("build_pack", { selection, destination, meta, onProgress: channel });
}

export function cancelPackBuild(): Promise<void> {
  return invoke("cancel_pack_build");
}

export function inspectPack(path: string): Promise<PackInspection> {
  return invoke<PackInspection>("inspect_pack", { path });
}

/** One staged scene source as text, hash-checked against the signed manifest on the way out. */
export function readPackSceneSource(path: string, source: SceneSource): Promise<string> {
  const { kind, slug, file } = source;
  return invoke<string>("read_pack_scene_source", { path, kind, slug, sceneFile: file });
}

/** Every scene sidecar beside a staged scene source, hash-checked, for the trust screen's review. */
export function readPackSceneDocs(path: string): Promise<PackSceneDoc[]> {
  return invoke<PackSceneDoc[]>("read_pack_scene_docs", { path });
}

/** Stage and plan in one call: extraction happens only after the user has seen what is inside. */
export function stageAndPlan(
  path: string,
  selection: PackSelection,
  onProgress?: (p: PackProgress) => void,
): Promise<ImportPlan> {
  const channel = new Channel<PackProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<ImportPlan>("stage_pack", { path, selection, onProgress: channel });
}

export function applyImport(
  resolutions: Record<string, Resolution>,
  onProgress?: (p: PackProgress) => void,
): Promise<ImportOutcome> {
  const channel = new Channel<PackProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<ImportOutcome>("apply_import", { resolutions, onProgress: channel });
}

export function discardStagedPack(): Promise<void> {
  return invoke("discard_staged_pack");
}

/** The Settings-owned publisher profile, as `set_publisher_profile` takes it. */
export interface PublisherProfile {
  name: string;
  organisation?: string | null;
  website?: string | null;
}

export interface PublisherKey {
  keyId: string;
  /** The same id in groups of four, for reading out loud. */
  keyIdDisplay: string;
  publicKey: string;
  /** The login Keychain, or the owner-only file where the Keychain could not answer. */
  storedIn: "keychain" | "file";
}

/** `get_publisher_profile` as Rust serialises it (`PublisherProfileView` in pack/publisher.rs): the saved profile rides nested under `profile`, absent until the pane has been saved once. */
export interface PublisherProfileView {
  profile: PublisherProfile | null;
  /** What a pack signed right now would carry; null until a profile is saved, when the packs window asks for a name. */
  effectiveName: string | null;
  organisation: string | null;
  website: string | null;
  /** Absent until the first pack is signed: the key is created lazily. */
  key: PublisherKey | null;
}

export function getPublisherProfile(): Promise<PublisherProfileView> {
  return invoke<PublisherProfileView>("get_publisher_profile");
}

export function revealInFinder(path: string): Promise<void> {
  return invoke("reveal_in_finder", { path });
}

/// The Save dialog can point outside the workspace, which `reveal_in_finder` refuses, so revealing a pack goes through
/// the path Rust wrote rather than one we hand back to it.
export function revealPack(): Promise<void> {
  return invoke("reveal_pack");
}
