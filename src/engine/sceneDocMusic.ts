import type { DeviceMediaSpec } from "../toolkit/device/Device";
import { type ProjectMusic, resolveSceneLocalMs } from "./musicTime";
import { inheritSceneDocBase } from "./sceneDocBase";
import type {
  SceneDoc,
  SceneDocCompare,
  SceneDocDeviceSpec,
  SceneDocMediaSpec,
} from "./sceneDocSchema";

/** Musical positions on sidecar times: camera, rig, lighting, device-track and comparison keys (side B's lighting included) may carry a sibling `at` beside `tMs`, and a device screen video or media video a sibling `at` beside `startMs`; the time caches `at` resolved under the project's grid and the scene's slot. The contract: a field keeps `at` only while its time equals that resolved value (an absent `startMs` counts as 0, as playback reads it). Edits detach (`detachSceneDocMusic`) then resolve; context changes (grid, offset, cues, sections, slot moves) only resolve. Both return the same doc object when nothing changes, so a project without a grid or any `at` never sees a new object (null-for-legacy). */

/** What one scene's keys resolve against: the project's music and the scene's slot start (project ms). */
export interface SceneDocMusicScope {
  music: ProjectMusic | undefined;
  sceneStartMs: number;
}

/** The scope for scene `index` of a loaded project. */
export function sceneMusicScope(
  project: { music?: ProjectMusic; slots?: readonly { startMs: number }[] },
  index: number,
): SceneDocMusicScope {
  return { music: project.music, sceneStartMs: project.slots?.[index]?.startMs ?? 0 };
}

const NO_MUSIC: ProjectMusic = { startOffsetMs: 0, cues: {}, sections: {} };

interface TimedKey {
  id: string;
  tMs: number;
  at?: string;
}

type TimeField = "tMs" | "startMs";

interface Timed {
  at?: string;
  tMs?: number;
  startMs?: number;
}

/** Why a resolved position can't apply to this field, or null. */
type Rule = (ms: number) => string | null;

type TimedEdit = <T extends Timed>(item: T, field: TimeField, where: string, rule?: Rule) => T;

function storedMs(item: Timed, field: TimeField): number | undefined {
  return field === "startMs" ? (item.startMs ?? 0) : item.tMs;
}

function position(
  item: Timed,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
  rule: Rule | undefined,
): { ok: true; ms: number } | { ok: false; message: string } {
  const r = resolveSceneLocalMs(item.at as string, music ?? NO_MUSIC, sceneStartMs);
  if (!r.ok) return r;
  const problem = rule?.(r.projectMs);
  return problem ? { ok: false, message: problem } : { ok: true, ms: r.projectMs };
}

/** A screen's `startMs` is scene time only on a video that doesn't count from a fold opening, and a parse drops `inMs` beside a negative one. */
function deviceMediaRule(spec: DeviceMediaSpec): Rule {
  return (ms) => {
    if (spec.kind !== "video") return "only a video's start can follow the music";
    if (spec.startOn === "open") return "startOn open counts startMs from the fold opening";
    if (ms < 0 && spec.inMs !== undefined) {
      return `lands ${-ms} ms before the scene starts, which can't combine with inMs`;
    }
    return null;
  };
}

/** Applies `edit` to every field carrying an `at`, copying only what changes. */
function mapTimed(doc: SceneDoc, edit: TimedEdit): SceneDoc {
  let next: SceneDoc | null = null;
  const draft = () => {
    next ??= { ...doc };
    return next;
  };
  const camera = editKeys(doc.camera?.keys, "camera", edit);
  if (camera && doc.camera) draft().camera = { ...doc.camera, keys: camera };
  const rig = editKeys(doc.cameraRig?.keys, "cameraRig", edit);
  if (rig && doc.cameraRig) draft().cameraRig = { ...doc.cameraRig, keys: rig };
  const lighting = editKeys(doc.lighting?.keys, "lighting", edit);
  if (lighting && doc.lighting) draft().lighting = { ...doc.lighting, keys: lighting };
  const poses = editKeys(doc.deviceTrack?.keys, "deviceTrack", edit);
  if (poses && doc.deviceTrack) draft().deviceTrack = { ...doc.deviceTrack, keys: poses };
  const devices = editList(doc.devices, (device) => editDevice(device, edit));
  if (devices) draft().devices = devices;
  const media = editList(doc.media, (entry) => editMediaEntry(entry, edit));
  if (media) draft().media = media;
  const compare = editCompare(doc.compare, edit);
  if (compare) draft().compare = compare;
  if (!next) return doc;
  inheritSceneDocBase(next, doc);
  return next;
}

function editList<T>(list: readonly T[] | undefined, edit: (item: T) => T): T[] | null {
  if (!Array.isArray(list)) return null;
  let changed = false;
  const out = list.map((item) => {
    const next = edit(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : null;
}

function editKeys<K extends TimedKey>(
  keys: readonly K[] | undefined,
  track: string,
  edit: TimedEdit,
): K[] | null {
  return editList(keys, (key) =>
    key && typeof key.at === "string" ? edit(key, "tMs", `${track} key "${key.id}"`) : key,
  );
}

function editDeviceMedia<S extends DeviceMediaSpec | undefined>(
  spec: S,
  where: string,
  edit: TimedEdit,
): S {
  if (!spec || typeof spec !== "object" || typeof spec.at !== "string") return spec;
  return edit(spec, "startMs", where, deviceMediaRule(spec));
}

function editDevice(device: SceneDocDeviceSpec, edit: TimedEdit): SceneDocDeviceSpec {
  let out = device;
  for (const field of ["media", "coverMedia"] as const) {
    const spec = device?.[field];
    const next = editDeviceMedia(spec, `device "${device.id}" ${field}`, edit);
    if (next !== spec) out = { ...out, [field]: next };
  }
  return out;
}

function editMediaEntry(entry: SceneDocMediaSpec, edit: TimedEdit): SceneDocMediaSpec {
  const video = entry?.video;
  if (!video || typeof video.at !== "string") return entry;
  const next = edit(video, "startMs", `media "${entry.id}" video`);
  return next === video ? entry : { ...entry, video: next };
}

function editCompare(
  compare: SceneDocCompare | undefined,
  edit: TimedEdit,
): SceneDocCompare | null {
  if (!compare) return null;
  let out: SceneDocCompare | null = null;
  const b = compare.b;
  if (b) {
    let side = b;
    const lighting = editKeys(b.lighting?.keys, "compare.b.lighting", edit);
    if (lighting && b.lighting) side = { ...side, lighting: { ...b.lighting, keys: lighting } };
    for (const field of ["media", "coverMedia"] as const) {
      const map = b[field];
      if (!map || typeof map !== "object") continue;
      let moved: Record<string, DeviceMediaSpec> | null = null;
      for (const [id, spec] of Object.entries(map)) {
        const next = editDeviceMedia(spec, `compare.b.${field} "${id}"`, edit);
        if (next !== spec) {
          moved ??= { ...map };
          moved[id] = next;
        }
      }
      if (moved) side = { ...side, [field]: moved };
    }
    if (side !== b) out = { ...compare, b: side };
  }
  const track = editKeys(compare.track?.keys, "compare.track", edit);
  if (track && compare.track) {
    out = { ...(out ?? compare), track: { ...compare.track, keys: track } };
  }
  return out;
}

/** Every field carrying an `at`, in resolution order, with its stored time (null when absent); `music-vectors.json` pins kb's mirror against it. */
export function sceneDocMusicFields(
  doc: SceneDoc,
): { where: string; field: TimeField; at: string; ms: number | null }[] {
  const out: { where: string; field: TimeField; at: string; ms: number | null }[] = [];
  mapTimed(doc, (item, field, where) => {
    out.push({ where, field, at: item.at as string, ms: item[field] ?? null });
    return item;
  });
  return out;
}

/** Sets each time from its `at`. An `at` that can't resolve (no grid, bad syntax, unknown cue) or can't apply to its field keeps its stored time and is reported once in `issues`. */
export function resolveSceneDocMusic(
  doc: SceneDoc,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
): { doc: SceneDoc; issues: string[] } {
  const issues: string[] = [];
  const next = mapTimed(doc, (item, field, where, rule) => {
    const r = position(item, music, sceneStartMs, rule);
    if (!r.ok) {
      issues.push(`${where} "${item.at}": ${r.message}`);
      return item;
    }
    return r.ms === storedMs(item, field) ? item : { ...item, [field]: r.ms };
  });
  if (next !== doc) issues.push(...crossedKeys(doc, next));
  return { doc: next, issues };
}

const TIMED_TRACKS: [string, (d: SceneDoc) => readonly TimedKey[] | undefined][] = [
  ["camera", (d) => d.camera?.keys],
  ["cameraRig", (d) => d.cameraRig?.keys],
  ["lighting", (d) => d.lighting?.keys],
  ["deviceTrack", (d) => d.deviceTrack?.keys],
  ["compare.b.lighting", (d) => d.compare?.b?.lighting?.keys],
  ["compare.track", (d) => d.compare?.track?.keys],
];

/** Tracks whose key order changed when their positions resolved: the segment between crossed keys is dropped on load, so say which. */
function crossedKeys(before: SceneDoc, after: SceneDoc): string[] {
  const order = (keys: readonly TimedKey[] | undefined) =>
    (Array.isArray(keys) ? keys : [])
      .filter((k) => k && Number.isFinite(k.tMs))
      .sort((a, b) => a.tMs - b.tMs)
      .map((k) => k.id)
      .join(" ");
  const out: string[] = [];
  for (const [track, keysOf] of TIMED_TRACKS) {
    const was = order(keysOf(before));
    const now = order(keysOf(after));
    if (was !== now) {
      out.push(
        `${track} keys reorder to ${now} under the current grid, so the moves between crossed keys are dropped; move a key or change its at`,
      );
    }
  }
  return out;
}

/** Drops `at` from every field whose time no longer equals its resolved position: the user moved it. An `at` that can't resolve or apply keeps both values. */
export function detachSceneDocMusic(
  doc: SceneDoc,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
): SceneDoc {
  return mapTimed(doc, (item, field, _where, rule) => {
    const r = position(item, music, sceneStartMs, rule);
    if (!r.ok || r.ms === storedMs(item, field)) return item;
    const { at: _moved, ...rest } = item;
    return rest as typeof item;
  });
}

/** The edit path: detach what moved, then resolve the rest. */
export function settleEditedSceneDocMusic(
  doc: SceneDoc,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
): SceneDoc {
  return resolveSceneDocMusic(detachSceneDocMusic(doc, music, sceneStartMs), music, sceneStartMs)
    .doc;
}

/** The context-change path over every scene: resolve only. `changed` lists the scenes whose time caches moved (their sidecars need rewriting); `docs` is the same array when none did. */
export function resolveProjectDocsMusic(
  docs: readonly (SceneDoc | undefined)[],
  music: ProjectMusic | undefined,
  slots: readonly { startMs: number }[],
): { docs: (SceneDoc | undefined)[]; changed: number[]; issues: string[] } {
  const changed: number[] = [];
  const issues: string[] = [];
  const out = docs.map((doc, i) => {
    if (!doc) return doc;
    const r = resolveSceneDocMusic(doc, music, slots[i]?.startMs ?? 0);
    for (const issue of r.issues) issues.push(`scene ${i + 1} ${issue}`);
    if (r.doc !== doc) changed.push(i);
    return r.doc;
  });
  return { docs: changed.length > 0 ? out : (docs as (SceneDoc | undefined)[]), changed, issues };
}
