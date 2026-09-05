// Only the hidden poster renderer sets revisions; ordinary editor and export URLs remain unchanged.
const revisions = new Map<string, string>();

export function setProjectAssetRevision(projectId: string, revision: string): void {
  revisions.set(projectId, revision);
}

export function projectAssetRevision(projectId: string | undefined): string | undefined {
  return projectId === undefined ? undefined : revisions.get(projectId);
}

export function withProjectAssetRevision(projectId: string, url: string): string {
  const revision = revisions.get(projectId);
  if (!revision) return url;
  const resolved =
    url.startsWith("/") && typeof location !== "undefined" ? new URL(url, location.href).href : url;
  return `${resolved}${resolved.includes("?") ? "&" : "?"}poster=${encodeURIComponent(revision)}`;
}
