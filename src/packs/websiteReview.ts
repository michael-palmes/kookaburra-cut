/** Post-import review of Website origins from the landed scene sidecars. Packs carry requests and poster pixels, never local grants or browser data. */

import { invoke } from "@tauri-apps/api/core";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import {
  normaliseWebsiteOrigin,
  parseSceneWebsite,
  resolveSceneWebsite,
} from "../engine/sceneWebsite";
import type { ImportOutcome } from "./types";

export interface WebsiteOriginReview {
  origin: string;
  loopback: boolean;
}

export interface WebsiteReviewRow {
  project: string;
  scene: string;
  file: string;
  origins: WebsiteOriginReview[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function websiteReviewRows(
  project: string,
  scenes: { file: string; doc: unknown }[],
): WebsiteReviewRow[] {
  const rows: WebsiteReviewRow[] = [];
  for (const { file, doc } of scenes) {
    if (!isRecord(doc) || doc.website === undefined) continue;
    const website = parseSceneWebsite(doc.website, `${project}/${file}`);
    const resolved = website ? resolveSceneWebsite({ website }) : null;
    if (!resolved) continue;
    const origins = resolved.requestedOrigins.flatMap((origin) => {
      const info = normaliseWebsiteOrigin(origin);
      return info ? [{ origin: info.origin, loopback: info.loopback }] : [];
    });
    if (origins.length === 0) continue;
    const name = typeof doc.name === "string" ? doc.name.trim() : "";
    rows.push({
      project,
      scene: name || file.replace(/^scenes\//, "").replace(/\.tsx$/, ""),
      file,
      origins,
    });
  }
  return rows;
}

async function reviewProjectWebsites(
  projects: { slug: string; name: string }[],
): Promise<WebsiteReviewRow[]> {
  const rows: WebsiteReviewRow[] = [];
  for (const project of projects) {
    try {
      const manifest = JSON.parse(await readProjectManifestSnapshot(project.slug)) as {
        scenes?: { file?: unknown }[];
      };
      const files = (manifest.scenes ?? [])
        .map((scene) => scene?.file)
        .filter((file): file is string => typeof file === "string" && file.endsWith(".tsx"));
      const scenes: { file: string; doc: unknown }[] = [];
      for (const file of files) {
        const text = await invoke<string | null>("read_scene_doc", {
          slug: project.slug,
          file: file.replace(/\.tsx$/, ".json"),
        });
        if (text != null) scenes.push({ file, doc: JSON.parse(text) });
      }
      rows.push(...websiteReviewRows(project.name, scenes));
    } catch (error) {
      console.warn(`[packs] Website review for "${project.slug}" failed:`, error);
    }
  }
  return rows;
}

export async function reviewImportedWebsites(outcome: ImportOutcome): Promise<WebsiteReviewRow[]> {
  const projects = outcome.results
    .filter(
      (result) =>
        result.kind === "project" &&
        (result.outcome === "added" ||
          result.outcome === "replaced" ||
          result.outcome === "keptBoth"),
    )
    .map((result) => ({ slug: result.slug, name: result.name }));
  return reviewProjectWebsites(projects);
}
