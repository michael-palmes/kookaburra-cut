/** The pack round trip: export a project to a `.kbpack`, import it straight back under a new slug, and hand the caller
 * the imported slug so the gate can verify BOTH and demand the same hash.
 *
 * Every other gate compares a render against a baseline recorded from the same files in the same place. A pack changes
 * the files' location, their slug, and potentially the font bytes behind them, so this is the only test that can catch a
 * lossy pack. Importing under a new slug rather than into a second workspace is deliberate: it proves slug and path
 * independence at the same time, in one app boot.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { ImportOutcome, ImportPlan, ItemKind, ItemPlan, Resolution } from "../packs/types";
import { EMPTY_SELECTION, type PackSelection, selectionKey } from "./packs";
import { nativeProjectSlug } from "./project";

export interface RoundTripResult {
  /** `ws:<slug>` of the re-imported copy, ready to verify. */
  importedProjectId: string;
  packPath: string;
  packBytes: number;
  itemCount: number;
}

/** Everything the pack carried, forced to `keep-both` so the copy lands beside the original rather than over it. */
function keepBothEverything(plan: ImportPlan): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const item of plan.items) {
    // Fonts cannot keep both: two files cannot own one (family, weight) in fonts.json.
    out[`${item.kind}:${item.slug}`] = item.kind === "font" ? "skip" : "keep-both";
  }
  return out;
}

function importedSlugFor(plan: ImportPlan, slug: string): string | null {
  const project = plan.items.find((i: ItemPlan) => i.kind === "project" && i.slug === slug);
  if (!project) return null;
  return project.keepBothSlug ?? project.slug;
}

export async function runPackRoundTrip(projectId: string): Promise<RoundTripResult> {
  const slug = nativeProjectSlug(projectId);
  const root = await invoke<string>("workspace_root_path");
  const packPath = `${root}/_autorun/roundtrip/${slug}.kbpack`;

  const plan = await invoke<{ items: { kind: ItemKind; slug: string; requiredBy: string[] }[] }>(
    "plan_pack",
    { selection: { ...EMPTY_SELECTION, projects: [slug] } },
  );
  // Ship the whole closure, not just the project: the closure IS what the gate is testing.
  const full: PackSelection = {
    ...EMPTY_SELECTION,
    projects: [],
    themes: [],
    fonts: [],
    objects: [],
    gradients: [],
    exportPresets: [],
    screenshots: [],
  };
  for (const item of plan.items) {
    if (item.kind !== "project" && item.requiredBy.length === 0) continue;
    if (item.kind === "project" && item.slug !== slug) continue;
    (full[selectionKey(item.kind)] as string[]).push(item.slug);
  }
  if (!full.projects.includes(slug)) full.projects.push(slug);

  const built = await invoke<{ path: string; bytes: number }>("build_pack", {
    selection: full,
    destination: packPath,
    meta: { name: `Round trip ${slug}` },
    onProgress: new Channel(),
  });

  const importPlan = await invoke<ImportPlan>("stage_pack", {
    path: built.path,
    selection: full,
    onProgress: new Channel(),
  });

  const outcome = await invoke<ImportOutcome>("apply_import", {
    resolutions: keepBothEverything(importPlan),
    onProgress: new Channel(),
  });
  const failed = outcome.results.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    throw new Error(
      `pack round trip: ${failed.length} item(s) failed to import: ${failed.map((f) => f.slug).join(", ")}`,
    );
  }
  if (outcome.stoppedAt) {
    throw new Error(`pack round trip: import stopped at ${outcome.stoppedAt}`);
  }

  const imported = importedSlugFor(importPlan, slug);
  if (!imported) {
    throw new Error(`pack round trip: the pack did not carry project "${slug}"`);
  }

  return {
    importedProjectId: `ws:${imported}`,
    packPath: built.path,
    packBytes: built.bytes,
    itemCount: importPlan.items.length,
  };
}
