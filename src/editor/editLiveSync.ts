import type {
  EditDoc,
  EditEntry,
  EditMask,
  EditRenderRecord,
  EditSource,
  EditStamps,
  EditTap,
  EditWrite,
} from "../engine/edit";
import { nextMaskId, pruneOrphanMasks } from "../engine/editMasks";
import { nextTapId, relayout } from "../engine/editMath";
import { isWriteConflict } from "../engine/sceneDocBase";

/** Editor live sync: the open editor follows outside writes to its edit doc (kb video, a second app). A stamp change acts once it reads the same on two polls; the editor's own writes are adopted so they never reload; an outside change merges three-way with any unsaved local edits. Pure: IO is injected, the EditorApp owns timers and UI. */

export interface EditStampState {
  /** The stamp last read or written; undefined until first observed, null = the file was missing. */
  baseline: string | null | undefined;
  /** A changed stamp seen on the previous poll, waiting to read the same again. */
  pending: { stamp: string | null } | null;
}

export type StampOutcome = "same" | "settling" | "changed" | "removed";

export function createEditStampState(stamp?: string | null): EditStampState {
  return { baseline: stamp, pending: null };
}

/** One poll: "changed" or "removed" once a new stamp reads identically twice; the first observation only sets the baseline. */
export function observeEditStamp(state: EditStampState, stamp: string | null): StampOutcome {
  if (state.baseline === undefined) {
    state.baseline = stamp;
    state.pending = null;
    return "same";
  }
  if (stamp === state.baseline) {
    state.pending = null;
    return "same";
  }
  if (!state.pending || state.pending.stamp !== stamp) {
    state.pending = { stamp };
    return "settling";
  }
  state.baseline = stamp;
  state.pending = null;
  return stamp === null ? "removed" : "changed";
}

/** The editor's own write landed: adopt its stamp only while the baseline still holds the one it replaced (the sourceBaseline `noteSourceWrite` rule), so an outside change in the same window still reloads. */
export function adoptOwnWrite(
  state: EditStampState,
  write: Pick<EditWrite, "stamp" | "before">,
): boolean {
  if (state.baseline === undefined || state.baseline !== (write.before ?? null)) return false;
  state.baseline = write.stamp;
  if (state.pending?.stamp === write.stamp) state.pending = null;
  return true;
}

/** Re-base after a read: the stamp of the bytes the editor now holds. */
export function resetEditStamp(state: EditStampState, stamp: string | null): void {
  state.baseline = stamp;
  state.pending = null;
}

/** Deep equality that treats an undefined-valued key as absent (spread edits leave them behind). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) if (!sameValue(ra[key], rb[key])) return false;
  return true;
}

export interface EditMerge {
  doc: EditDoc;
  /** Keys whose local change lost to a clashing outside change: `clips`, `tapSize`, `taps.t3`, `masks.m2`, `sources.s2`. */
  dropped: string[];
  /** The result holds local changes the outside doc lacks, so it must be saved. */
  keptLocal: boolean;
}

const WHOLE_KEYS = ["clips", "settings", "tapStyle", "tapColor", "tapSize", "reference"] as const;

type Pick3 = { value: unknown; local: boolean; clash: boolean };

function pick3(base: unknown, local: unknown, remote: unknown): Pick3 {
  if (sameValue(local, base)) return { value: remote, local: false, clash: false };
  if (sameValue(remote, base) || sameValue(local, remote)) {
    return { value: local, local: !sameValue(local, remote), clash: false };
  }
  return { value: remote, local: false, clash: true };
}

function mergeById<T extends { id: string }>(
  family: "taps" | "masks",
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  dropped: string[],
  nextId: (taken: T[]) => string,
): { list: T[]; keptLocal: boolean } {
  const byId = (list: readonly T[]) => new Map(list.map((item) => [item.id, item]));
  const b = byId(base);
  const l = byId(local);
  const r = byId(remote);
  const list: T[] = [];
  const renamed: T[] = [];
  let keptLocal = false;
  for (const item of remote) {
    const lv = l.get(item.id);
    const bv = b.get(item.id);
    const pick = pick3(bv, lv, item);
    if (pick.clash && bv === undefined && lv) {
      // Both sides added the same fresh id: keep both, the local one under a new id.
      list.push(item);
      renamed.push(lv);
      keptLocal = true;
    } else if (pick.clash) {
      list.push(item);
      dropped.push(`${family}.${item.id}`);
    } else {
      if (pick.value !== undefined) list.push(pick.value as T);
      keptLocal ||= pick.local;
    }
  }
  for (const item of local) {
    if (r.has(item.id)) continue;
    const bv = b.get(item.id);
    if (bv === undefined) {
      list.push(item);
      keptLocal = true;
    } else if (!sameValue(item, bv)) {
      dropped.push(`${family}.${item.id}`);
    }
  }
  for (const item of renamed) list.push({ ...item, id: nextId(list) });
  return { list, keptLocal };
}

/** Sources as a union by id: the outside list, then local-only sources unless the outside doc removed one nothing uses. */
function mergeSources(
  base: readonly EditSource[],
  local: readonly EditSource[],
  remote: readonly EditSource[],
  used: Set<string>,
  dropped: string[],
): { list: EditSource[]; keptLocal: boolean } {
  const b = new Map(base.map((s) => [s.id, s]));
  const l = new Map(local.map((s) => [s.id, s]));
  const r = new Set(remote.map((s) => s.id));
  let keptLocal = false;
  const list = remote.map((s) => {
    const pick = pick3(b.get(s.id), l.get(s.id) ?? s, s);
    if (pick.clash) dropped.push(`sources.${s.id}`);
    keptLocal ||= pick.local;
    return pick.value as EditSource;
  });
  for (const s of local) {
    if (r.has(s.id) || (b.has(s.id) && !used.has(s.id))) continue;
    list.push(s);
    keptLocal = true;
  }
  return { list, keptLocal };
}

const normalise = (doc: EditDoc): EditDoc => ({ ...doc, clips: relayout(doc.clips) });

/** Three-way merge of the doc the editor last read (`base`), its current doc (`local`, unsaved changes included) and the doc on disk (`remote`). Whole values per top-level key, taps and masks per id, sources as a union; a clash goes to remote and is listed in `dropped`. The result is relaid out and orphan masks pruned. */
export function mergeEditDocs(base: EditDoc, local: EditDoc, remote: EditDoc): EditMerge {
  const b = normalise(base);
  const l = normalise(local);
  const r = normalise(remote);
  const dropped: string[] = [];
  let keptLocal = false;
  const out: Record<string, unknown> = { ...r };
  for (const key of WHOLE_KEYS) {
    const pick = pick3(b[key], l[key], r[key]);
    if (pick.clash) dropped.push(key);
    keptLocal ||= pick.local;
    if (pick.value === undefined) delete out[key];
    else out[key] = pick.value;
  }
  const taps = mergeById<EditTap>(
    "taps",
    b.taps ?? [],
    l.taps ?? [],
    r.taps ?? [],
    dropped,
    nextTapId,
  );
  const masks = mergeById<EditMask>(
    "masks",
    b.masks ?? [],
    l.masks ?? [],
    r.masks ?? [],
    dropped,
    nextMaskId,
  );
  const clips = relayout(out.clips as EditDoc["clips"]);
  const used = new Set<string>([
    ...clips.map((c) => c.sourceId),
    ...taps.list.map((t) => t.sourceId),
    ...masks.list.map((m) => m.sourceId),
  ]);
  const sources = mergeSources(b.sources, l.sources, r.sources, used, dropped);
  keptLocal ||= taps.keptLocal || masks.keptLocal || sources.keptLocal;
  const doc = { ...out, clips, sources: sources.list } as EditDoc;
  if (taps.list.length > 0 || r.taps !== undefined) doc.taps = taps.list;
  else delete doc.taps;
  if (masks.list.length > 0 || r.masks !== undefined) {
    doc.masks = pruneOrphanMasks(clips, masks.list, sources.list);
  } else {
    delete doc.masks;
  }
  return { doc, dropped, keptLocal };
}

const DROPPED_NAMES: Record<string, string> = {
  clips: "the clips",
  settings: "the output settings",
  tapStyle: "the tap style",
  tapColor: "the tap colour",
  tapSize: "the tap size",
  reference: "the compare video",
};

/** Toast copy for a merge that dropped local changes, or null when nothing was dropped. */
export function describeDropped(dropped: readonly string[]): string | null {
  if (dropped.length === 0) return null;
  const names = dropped.map((key) => {
    const [family, id] = key.split(".");
    if (id === undefined) return DROPPED_NAMES[key] ?? key;
    const noun = family === "taps" ? "tap" : family === "masks" ? "mask" : "source";
    return `${noun} ${id}`;
  });
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Claude edited this too: your changes to ${list} were replaced.`;
}

/** The commands live sync reads and writes through (edit.ts in the app, fakes in tests). */
export interface EditSyncIO {
  stamps: (slug: string, name: string) => Promise<EditStamps>;
  load: (slug: string, name: string) => Promise<EditEntry>;
  save: (slug: string, name: string, doc: EditDoc, baseHash: string | null) => Promise<EditWrite>;
}

export interface EditTargetKey {
  slug: string;
  name: string;
}

export interface EditWatch {
  doc: EditStampState;
  render: EditStampState;
}

export type PollOutcome =
  | { kind: "idle" }
  | { kind: "removed" }
  | { kind: "changed"; entry: EditEntry }
  | { kind: "unreadable"; error: string }
  | { kind: "render"; render: EditRenderRecord | null; hash: string };

/** One poll tick: stamps, then a read when the doc settled on a new stamp (or `force`), or when only the render record moved. */
export async function pollEdit(
  io: Pick<EditSyncIO, "stamps" | "load">,
  target: EditTargetKey,
  watch: EditWatch,
  force = false,
): Promise<PollOutcome> {
  const stamps = await io.stamps(target.slug, target.name);
  const doc = observeEditStamp(watch.doc, stamps.doc);
  const render = observeEditStamp(watch.render, stamps.render);
  if (doc === "removed" || (force && stamps.doc === null)) {
    resetEditStamp(watch.doc, null);
    return { kind: "removed" };
  }
  const docMoved = doc === "changed" || force;
  if (!docMoved && render !== "changed" && render !== "removed") return { kind: "idle" };
  let entry: EditEntry;
  try {
    entry = await io.load(target.slug, target.name);
  } catch (e) {
    return { kind: "unreadable", error: String(e) };
  }
  if (docMoved) return { kind: "changed", entry };
  return { kind: "render", render: entry.render, hash: entry.hash };
}

export type SaveOutcome =
  /** `doc` is on disk now, with `write`'s hash and stamp. */
  | { kind: "saved"; doc: EditDoc; write: EditWrite }
  /** A conflict resolved to the outside doc with nothing of ours to add. */
  | { kind: "adopted"; entry: EditEntry }
  /** A conflict the caller could not merge yet (the UI was busy); `doc` still needs saving. */
  | { kind: "deferred"; doc: EditDoc };

/** What to save after a conflict re-read: the merged doc, null when the outside doc already holds everything, or "defer". */
export type ConflictResolver = (entry: EditEntry) => EditDoc | null | "defer";

/** Save against `baseHash`; on a conflict re-read, let `resolve` merge, and save once more against the fresh hash. A second conflict or any other failure throws. */
export async function saveWithRebase(
  io: Pick<EditSyncIO, "save" | "load">,
  target: EditTargetKey,
  doc: EditDoc,
  baseHash: string | null,
  resolve: ConflictResolver,
): Promise<SaveOutcome> {
  try {
    return { kind: "saved", doc, write: await io.save(target.slug, target.name, doc, baseHash) };
  } catch (e) {
    if (!isWriteConflict(e) || baseHash === null) throw e;
  }
  const entry = await io.load(target.slug, target.name);
  const merged = resolve(entry);
  if (merged === "defer") return { kind: "deferred", doc };
  if (merged === null) return { kind: "adopted", entry };
  const write = await io.save(target.slug, target.name, merged, entry.hash);
  return { kind: "saved", doc: merged, write };
}
