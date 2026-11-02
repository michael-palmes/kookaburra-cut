/** The pre-import review: Website origins in the sidecars a pack carries, grouped per project, template or preset. Runs over `read_pack_scene_docs`, which reads each sidecar from the pack and checks it against the signed hash, so what is shown on the trust screen is what staging would land. */

import { KIND_LABELS, type PackSceneDoc } from "./types";
import { type WebsiteReviewRow, websiteReviewRows } from "./websiteReview";

export interface PackReview {
  websites: WebsiteReviewRow[];
}

export function reviewPackSceneDocs(docs: PackSceneDoc[]): PackReview {
  const groups = new Map<string, { label: string; scenes: { file: string; doc: unknown }[] }>();
  for (const { kind, slug, name, file, doc } of docs) {
    const key = `${kind}:${slug}`;
    const label = kind === "project" ? name : `${name} (${KIND_LABELS[kind].one.toLowerCase()})`;
    const group = groups.get(key) ?? { label, scenes: [] };
    group.scenes.push({ file, doc });
    groups.set(key, group);
  }
  const websites: WebsiteReviewRow[] = [];
  for (const { label, scenes } of groups.values()) {
    websites.push(...websiteReviewRows(label, scenes));
  }
  return { websites };
}
