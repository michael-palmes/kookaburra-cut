import type { LightingKey } from "../theme/tokens";
import { type ProjectMusic, resolveSceneLocalMs } from "./musicTime";
import { inheritSceneDocBase } from "./sceneDocBase";
import type { SceneDoc } from "./sceneDocSchema";

/** Musical positions on sidecar keys: camera, rig and lighting keys (side B's lighting included) may carry a sibling `at` beside `tMs`, and `tMs` caches `at` resolved under the project's grid and the scene's slot. The contract: a key keeps `at` only while its `tMs` equals that resolved value. Edits detach (`detachSceneDocMusic`) then resolve; context changes (grid, offset, cues, sections, slot moves) only resolve. Both return the same doc object when nothing changes, so a project without a grid or any `at` never sees a new object (null-for-legacy). */

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

type KeyEdit = (key: TimedKey, where: string) => TimedKey;

/** Applies `edit` to every timed key, copying only the tracks that change. */
function mapTimedKeys(doc: SceneDoc, edit: KeyEdit): SceneDoc {
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
  const bLighting = doc.compare?.b?.lighting;
  const after = editKeys(bLighting?.keys, "compare.b.lighting", edit);
  if (after && doc.compare?.b && bLighting) {
    draft().compare = {
      ...doc.compare,
      b: { ...doc.compare.b, lighting: { ...bLighting, keys: after as LightingKey[] } },
    };
  }
  if (!next) return doc;
  inheritSceneDocBase(next, doc);
  return next;
}

function editKeys<K extends TimedKey>(
  keys: readonly K[] | undefined,
  track: string,
  edit: KeyEdit,
): K[] | null {
  if (!Array.isArray(keys)) return null;
  let changed = false;
  const out = keys.map((key) => {
    if (!key || typeof key.at !== "string") return key;
    const next = edit(key, `${track} key "${key.id}"`) as K;
    if (next !== key) changed = true;
    return next;
  });
  return changed ? out : null;
}

/** Sets each `tMs` from its `at`. An `at` that can't resolve (no grid, bad syntax, unknown cue) keeps its stored `tMs` and is reported once in `issues`. */
export function resolveSceneDocMusic(
  doc: SceneDoc,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
): { doc: SceneDoc; issues: string[] } {
  const issues: string[] = [];
  const next = mapTimedKeys(doc, (key, where) => {
    const r = resolveSceneLocalMs(key.at as string, music ?? NO_MUSIC, sceneStartMs);
    if (!r.ok) {
      issues.push(`${where} "${key.at}": ${r.message}`);
      return key;
    }
    return r.projectMs === key.tMs ? key : { ...key, tMs: r.projectMs };
  });
  if (next !== doc) issues.push(...crossedKeys(doc, next));
  return { doc: next, issues };
}

const TIMED_TRACKS: [string, (d: SceneDoc) => readonly TimedKey[] | undefined][] = [
  ["camera", (d) => d.camera?.keys],
  ["cameraRig", (d) => d.cameraRig?.keys],
  ["lighting", (d) => d.lighting?.keys],
  ["compare.b.lighting", (d) => d.compare?.b?.lighting?.keys],
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

/** Drops `at` from every key whose `tMs` no longer equals its resolved position: the user moved it. An unresolvable `at` keeps both values. */
export function detachSceneDocMusic(
  doc: SceneDoc,
  music: ProjectMusic | undefined,
  sceneStartMs: number,
): SceneDoc {
  return mapTimedKeys(doc, (key) => {
    const r = resolveSceneLocalMs(key.at as string, music ?? NO_MUSIC, sceneStartMs);
    if (!r.ok || r.projectMs === key.tMs) return key;
    const { at: _moved, ...rest } = key;
    return rest;
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

/** The context-change path over every scene: resolve only. `changed` lists the scenes whose `tMs` caches moved (their sidecars need rewriting); `docs` is the same array when none did. */
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
