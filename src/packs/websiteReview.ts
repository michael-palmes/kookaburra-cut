/** Review of Website origins in scene sidecars, shown on the pack trust screen before anything lands (`packReview.ts`, over hash-checked sidecars read from the pack). Packs carry requests and poster pixels, never local grants or browser data. */

import {
  normaliseWebsiteOrigin,
  parseSceneWebsite,
  resolveSceneWebsite,
} from "../engine/sceneWebsite";

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
