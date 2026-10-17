/** The `kookaburra://media-changed` broadcast: null from imports, deletes and cache clears; `{ slug, name }` from an editor render; `{ slug, paths, edit, origin: "agent" }` from the bridge's `mediaChanged` (docs/agent-kit.md, "The bridge (v2)"). */
export interface MediaChangedPayload {
  slug?: string;
  name?: string;
  paths?: string[];
  edit?: string | null;
  origin?: string;
}

/** An editor render: the edit a pending scene re-point waits for. */
export interface EditRender {
  slug: string;
  name: string;
}

export function readMediaChanged(raw: unknown): MediaChangedPayload | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as MediaChangedPayload)
    : null;
}

/** The workspace project slug a broadcast names, if any. */
export function mediaChangedSlug(raw: unknown): string | null {
  const slug = readMediaChanged(raw)?.slug;
  return typeof slug === "string" && slug ? slug : null;
}

/** kb owns what an agent render means for the project (re-points, follow-media durations), so the app only refreshes for it. */
export function isAgentMediaChange(raw: unknown): boolean {
  return readMediaChanged(raw)?.origin === "agent";
}

/** Whether a broadcast is the editor render a pending re-point armed for: its own project and edit, never an agent's. */
export function editRenderMatchesPending(
  raw: unknown,
  pending: { slug: string; editName: string } | null,
): boolean {
  const payload = readMediaChanged(raw);
  return (
    pending !== null &&
    payload !== null &&
    !isAgentMediaChange(payload) &&
    typeof payload.name === "string" &&
    payload.slug === pending.slug &&
    payload.name === pending.editName
  );
}

/** What the main window owes since its last media sweep (broadcasts coalesce between sweeps). */
export interface MediaChangeBatch {
  /** Projects whose asset inventory must be re-read. */
  slugs: Set<string>;
  /** The latest editor render, for the pending re-point. */
  rendered: EditRender | null;
  /** False when only agent broadcasts arrived: the follow-media duration sync is kb's then. */
  syncDurations: boolean;
}

export function emptyMediaChangeBatch(): MediaChangeBatch {
  return { slugs: new Set(), rendered: null, syncDurations: false };
}

export function noteMediaChange(batch: MediaChangeBatch, raw: unknown): void {
  const payload = readMediaChanged(raw);
  const slug = mediaChangedSlug(payload);
  if (slug) batch.slugs.add(slug);
  if (isAgentMediaChange(payload)) return;
  batch.syncDurations = true;
  if (slug && typeof payload?.name === "string" && payload.name) {
    batch.rendered = { slug, name: payload.name };
  }
}
