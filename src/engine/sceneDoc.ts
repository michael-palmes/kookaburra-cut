import { invoke } from "@tauri-apps/api/core";
import { useContext, useId, useLayoutEffect, useMemo } from "react";
import type { DeviceId } from "../toolkit/device/catalog";
import type { DeviceMediaSpec, DeviceProps } from "../toolkit/device/Device";
import { resolveDeviceLayout } from "../toolkit/device/layout";
import { useChartRegistry } from "./chartRegistry";
import { hasPlaybackKeys } from "./clipFrame";
import { useDeviceRegistry } from "./deviceRegistry";
import {
  compareSlotMedia,
  type DeviceScreenSlot,
  deviceSlotMedia,
  deviceVideoSlots,
  setCompareSlotMedia,
  setDeviceSlotMedia,
} from "./deviceScreens";
import { useFormat } from "./format";
import { clampTrackToDuration, type KeyedTrack } from "./keyedTrack";
import { useLayeredScreenshotRegistry } from "./layeredScreenshotRegistry";
import { type ManagedTextRenderRole, resolveTemplateManagedTextCopy } from "./managedText";
import { useObjectRegistry } from "./objectRegistry";
import { isEditableProjectId, type LoadedProject, nativeProjectSlug } from "./project";
import { updateSceneDuration } from "./projectEdit";
import { type ResolvedChart, resolveChart } from "./sceneChart";
import { SceneDocContext, useSceneContext } from "./sceneContext";
import {
  ABSENT_BASE,
  asWriteConflict,
  type FileWrite,
  noteAppHash,
  rememberSceneDocHash,
  sceneDocBase,
} from "./sceneDocBase";
import { parseSceneDoc, type SceneDoc, type SceneDocMediaSpec } from "./sceneDocSchema";
import {
  type NormalizedLayeredScreenshot,
  normalizeLayeredScreenshot,
} from "./sceneLayeredScreenshot";
import {
  editSceneDocMedia,
  sceneMediaFamily as familyOfMedia,
  pinnedFollowMediaEntry,
  resolveSceneDocMedia,
  type SceneMediaFamily,
  videoWindowMediaEntry,
} from "./sceneMedia";
import { useSceneMediaRegistry } from "./sceneMediaRegistry";
import { noteSourceWrite } from "./sourceBaseline";
import { clampStillMarks } from "./stills";
import { useTextKeyRegistry } from "./textKeyRegistry";

/** Scene-document IO and hooks: docs load beside their scene modules in `loadProject` into `LoadedProject.sceneDocs` and reach components via `SceneHost`'s `SceneDocContext`, but the engine (camera sampling, duration sync) reads `LoadedProject.sceneDocs` directly so export never touches React context or the editor store; schema and validation live in `sceneDocSchema.ts`. */

/** Editable sidecars read fresh through native IO; read-only bundled scenes use their build-time imports. */
export async function loadSceneDoc(
  projectId: string,
  sceneFile: string,
  bundledDocs: Record<string, () => Promise<{ default: unknown }>>,
  bundledDir?: string,
): Promise<SceneDoc | undefined> {
  const docFile = sceneFile.replace(/\.tsx$/, ".json");
  if (docFile === sceneFile) return undefined;
  if (isEditableProjectId(projectId)) {
    const slug = nativeProjectSlug(projectId);
    try {
      return (await readSceneDocEntry(slug, docFile)).doc;
    } catch (e) {
      console.warn(`[sceneDoc] reading ${slug}/${docFile} failed:`, e);
      return undefined;
    }
  }
  const key = `${bundledDir ?? `/projects/${projectId}`}/${docFile}`;
  const load = bundledDocs[key];
  if (!load) return undefined;
  return parseSceneDoc((await load()).default, key);
}

/** A sidecar read with its content hash remembered as the document's write base; throws when the file exists but can't be read or parsed. */
export async function readSceneDocEntry(
  slug: string,
  docFile: string,
): Promise<{ doc: SceneDoc | undefined; hash: string }> {
  const entry = await invoke<{ text: string; hash: string } | null>("read_scene_doc_entry", {
    slug,
    file: docFile,
  });
  if (entry == null) return { doc: undefined, hash: ABSENT_BASE };
  const doc = parseSceneDoc(JSON.parse(entry.text), `${slug}/${docFile}`);
  if (!doc) throw new Error(`${docFile} isn't a scene document this version can read`);
  rememberSceneDocHash(doc, entry.hash);
  return { doc, hash: entry.hash };
}

// ── Hooks (inside the canvas subtree, via SceneHost's SceneDocContext) ──────────

/** The mounted scene's document, or null when it has none. */
export function useSceneDoc(): SceneDoc | null {
  return useContext(SceneDocContext);
}

/** Resolves code-owned or embedded copy, plus the matching item while a managed scaffold retains its template layout. */
export function useSceneText(
  key: string,
  fallback = "",
  managedTextRole: ManagedTextRenderRole = "scene",
): string {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  const mountId = useId();
  const authored = doc?.text?.[key] ?? fallback;
  const resolved =
    managedTextRole === "scene" ? resolveTemplateManagedTextCopy(doc, key, authored) : authored;
  // Layout effect so TextFallback's render gate settles in the same commit, never a painted frame late.
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useTextKeyRegistry
      .getState()
      .register(sceneIndex, key, mountId, { resolvedText: resolved, managedTextRole });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, key, mountId);
  }, [sceneIndex, key, mountId, resolved, managedTextRole]);
  return resolved;
}

/** `Device`-spreadable props (the sidecar device entry, with `model` narrowed). */
export interface SceneDeviceProps extends Omit<DeviceProps, "model"> {
  id: string;
  model: DeviceId;
}

/** The scene document's devices array as `Device`-ready props; unknown models pass through since `Device` itself degrades (console error + fallback geometry) rather than crashing the tree. A `deviceLayout` block resolves to per-aspect placements HERE, so every consuming scene (any kind, any scaffold vintage) honours it without template changes; templates that resolve the block themselves recompute the identical values (the resolver is pure and ignores input placements beyond `ground`). */
export function useSceneDevices(): SceneDeviceProps[] {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  const format = useFormat();
  // Layout effect so DevicesFallback's render gate settles in the same commit, never a painted frame late.
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useDeviceRegistry.getState().register(sceneIndex);
    return () => useDeviceRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  const devices = (doc?.devices ?? []).map((d) => d as SceneDeviceProps);
  const layout = doc?.deviceLayout;
  if (!layout) return devices;
  const placements = resolveDeviceLayout(devices, layout, format);
  return devices.map((d, i) => ({ ...d, placement: placements[i] }));
}

/** The scene document's objects array; registers the scene as a consumer so `ObjectsFallback` stands down (the useSceneDevices pattern). */
export function useSceneObjects() {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useObjectRegistry.getState().register(sceneIndex);
    return () => useObjectRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  return doc?.objects ?? [];
}

/** The scene document's layeredScreenshot block, deep-validated, or null when absent; registers the scene as a consumer so `LayeredScreenshotFallback` stands down (the useSceneDevices pattern). */
export function useSceneLayeredScreenshot(): NormalizedLayeredScreenshot | null {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useLayeredScreenshotRegistry.getState().register(sceneIndex);
    return () => useLayeredScreenshotRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  const block = doc?.layeredScreenshot;
  return useMemo(
    () => normalizeLayeredScreenshot(block, `scene ${sceneIndex ?? "?"}`),
    [block, sceneIndex],
  );
}

/** The scene document's media entries for one fallback family; registers the scene as that family's consumer so `SceneMediaFallback` stands down for it (the useSceneLayeredScreenshot pattern). */
export function useSceneMedia(family: SceneMediaFamily): SceneDocMediaSpec[] {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useSceneMediaRegistry.getState().register(sceneIndex, family);
    return () => useSceneMediaRegistry.getState().unregister(sceneIndex, family);
  }, [sceneIndex, family]);
  return useMemo(
    () => resolveSceneDocMedia(doc ?? undefined).filter((e) => familyOfMedia(e) === family),
    [doc, family],
  );
}

/** The scene document's chart block, fully resolved (defaults baked, data track sorted), or null when absent; registers the scene as a consumer so a host-mounted `ChartFallback` stands down (the useSceneMedia pattern). */
export function useSceneChart(): ResolvedChart | null {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useChartRegistry.getState().register(sceneIndex);
    return () => useChartRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  return useMemo(() => resolveChart(doc ?? undefined), [doc]);
}

// ── Sidecar writes (shared by the wizards and the edit bar) ────────────────────

const sceneDocWriteQueues = new Map<string, Promise<unknown>>();

export async function settleSceneDocWrites(): Promise<void> {
  while (sceneDocWriteQueues.size) await Promise.all([...sceneDocWriteQueues.values()]);
}

/** Atomic, version-guarded sidecar write via the native command. `base` is the hash the document was derived from (`sceneDocBase`); the write throws `WriteConflictError` when the file changed since, and on success `doc` carries the new hash. */
export async function writeSceneDoc(
  slug: string,
  sceneFile: string,
  doc: SceneDoc,
  base: string | undefined,
): Promise<FileWrite | null> {
  const file = sceneFile.replace(/\.tsx$/, ".json");
  const key = `${slug}\u0000${file}`;
  const previous = sceneDocWriteQueues.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      try {
        return await invoke<FileWrite | null>("write_scene_doc", {
          slug,
          file,
          text: JSON.stringify(doc, null, 2),
          baseHash: base ?? null,
        });
      } catch (e) {
        throw asWriteConflict(e) ?? e;
      }
    });
  sceneDocWriteQueues.set(key, write);
  try {
    const written = await write;
    if (written) {
      rememberSceneDocHash(doc, written.hash);
      noteAppHash(written.hash);
      noteSourceWrite(slug, written);
    }
    return written;
  } finally {
    if (sceneDocWriteQueues.get(key) === write) sceneDocWriteQueues.delete(key);
  }
}

/** Which surface an edit render re-points. `media` carries the entry id in `targetId`, the device slots a device id. */
export type EditRepointSlot =
  | "device"
  | "compareDevice"
  | "deviceCover"
  | "compareDeviceCover"
  | "background"
  | "videoWindow"
  | "media";

const DEVICE_PLAYBACK_KEYS = ["inMs", "outMs", "speed", "loop", "posterMs"] as const;

/** A device screen pointed at a render: the edit now owns the timing, so the source-timing keys and a negative `startMs` (a head trim) go, while a delay and `startOn` stay. */
function repointedDeviceMedia(media: DeviceMediaSpec, rel: string): DeviceMediaSpec {
  const next: DeviceMediaSpec = { ...media, src: rel, kind: "video" };
  for (const key of DEVICE_PLAYBACK_KEYS) delete next[key];
  if (typeof next.startMs === "number" && next.startMs < 0) delete next.startMs;
  return next;
}

/** Applies an edit-render re-point to a scene doc: the slot's media src becomes `rel` (the freshly rendered `assets/<name>-edited.mp4`), and a device or media slot's kind becomes "video" (an edited still renders out as a clip). Pure clone-and-patch so App can write, patch in memory and record undo atomically; returns null when the slot has nothing to re-point. A `targetId` names the device or media entry alone (a stale id re-points nothing, never a neighbour); without one the first device keeps the legacy behaviour. A device slot also sheds its source timing (`repointedDeviceMedia`). */
export function applyEditRepoint(
  doc: SceneDoc,
  slot: EditRepointSlot,
  rel: string,
  targetId?: string,
): SceneDoc | null {
  const next = structuredClone(doc);
  if (slot === "background") {
    if (next.background?.type !== "video") return null;
    next.background = { ...next.background, src: rel };
    return next;
  }
  if (slot === "media" || slot === "videoWindow") {
    const entries = resolveSceneDocMedia(next);
    const entry = targetId
      ? entries.find((candidate) => candidate.id === targetId)
      : videoWindowMediaEntry(entries);
    if (!entry) return null;
    entry.src = rel;
    // The render is always an mp4, so a re-pointed still becomes a clip and starts from its head.
    entry.kind = "video";
    const video = { ...entry.video };
    delete video.startMs;
    entry.video = video;
    editSceneDocMedia(next, () => entries);
    return next;
  }
  const device = targetId ? next.devices?.find((d) => d.id === targetId) : next.devices?.[0];
  if (!device) return null;
  const screen: DeviceScreenSlot =
    slot === "deviceCover" || slot === "compareDeviceCover" ? "cover" : "main";
  if (slot === "compareDevice" || slot === "compareDeviceCover") {
    if (!next.compare) return null;
    const media = compareSlotMedia(next, device.id, screen) ?? deviceSlotMedia(device, screen);
    if (!media) return null;
    setCompareSlotMedia(next, device.id, screen, repointedDeviceMedia(media, rel));
    return next;
  }
  const media = deviceSlotMedia(device, screen);
  if (!media) return null;
  setDeviceSlotMedia(device, screen, repointedDeviceMedia(media, rel));
  return next;
}

// ── Duration-follow (engine-side; reads LoadedProject directly, never React context) ──

interface MediaMetaLike {
  durationMs: number;
}

/** One video a follow-media scene's length derives from; a device screen carries the spec that times it. */
export interface FollowMediaSlot {
  src: string;
  spec?: DeviceMediaSpec;
}

/** The videos a follow-media scene's duration derives from (pure so tests can pin it; the resync probes them all and follows the LONGEST). A media pin (`source: "media"` with a `sourceMediaId`, or the legacy `"videoWindow"` naming whichever entry serves as the window) follows that entry alone; a matching `sourceDeviceId` pins one device; a comparison's `compare.b.media` videos count beside each device's own (both sides render, so neither recording may cut short); unpinned (or stale-pinned) docs return every qualifying video; device-less docs keep the media-then-background chain. */
export function followMediaSlots(doc: SceneDoc | undefined): FollowMediaSlot[] {
  const duration = doc?.duration;
  if (duration?.mode !== "follow-media") return [];
  const media = resolveSceneDocMedia(doc);
  if (duration.source === "media" || duration.source === "videoWindow") {
    const entry = pinnedFollowMediaEntry(duration, media);
    return entry?.kind === "video" ? [{ src: entry.src }] : [];
  }
  const devices = doc?.devices ?? [];
  const pinned = devices.find((d) => d.id === duration.sourceDeviceId);
  const deviceVideos = (pinned ? [pinned] : devices).flatMap((d) =>
    deviceVideoSlots(doc, d).map((spec) => ({ src: spec.src, spec })),
  );
  if (deviceVideos.length > 0) return deviceVideos;
  const mediaVideos = media
    .filter((entry) => entry.kind === "video")
    .map((entry) => ({ src: entry.src }));
  if (mediaVideos.length > 0) return mediaVideos;
  if (doc?.background?.type === "video") return [{ src: doc.background.src }];
  return [];
}

/** `followMediaSlots`, sources only. */
export function followMediaSources(doc: SceneDoc | undefined): string[] {
  return followMediaSlots(doc).map((slot) => slot.src);
}

/** How long one slot plays its probed video: a screen with source timing runs `startMs + (min(outMs, probed) - inMs) / speed` (one pass of a loop; `startOn` stays out), at least 17 ms; any other slot is the probed length, still ignoring `startMs`. */
export function followMediaLengthMs(spec: DeviceMediaSpec | undefined, probedMs: number): number {
  if (!spec || !hasPlaybackKeys(spec)) return probedMs;
  const startMs =
    typeof spec.startMs === "number" && Number.isFinite(spec.startMs) ? spec.startMs : 0;
  const endMs = Math.min(spec.outMs ?? probedMs, probedMs);
  return Math.max(17, Math.round(startMs + (endMs - (spec.inMs ?? 0)) / (spec.speed ?? 1)));
}

/** The length a follow-media scene follows: its longest slot by `followMediaLengthMs`; a source probed at 0 ms (or not at all) counts for nothing, so 0 means leave the scene alone. */
export function followMediaDurationMs(
  slots: readonly FollowMediaSlot[],
  probedMs: ReadonlyMap<string, number>,
): number {
  let longest = 0;
  for (const slot of slots) {
    const probed = probedMs.get(slot.src) ?? 0;
    if (probed > 0) longest = Math.max(longest, followMediaLengthMs(slot.spec, probed));
  }
  return longest;
}

/** Re-syncs one follow-media scene's `project.json` duration from its source videos' probed lengths (no-op for manual mode, image, or missing media); slots come from `followMediaSlots` and lengths from `followMediaDurationMs`, the longest winning when more than one device video qualifies. `wrote` says `project.json` was rewritten so UI callers know a timing refresh is needed (sidecar-only edits patch in memory and never reload); when a shrink leaves keyframe tracks overhanging and `sceneFile` is given, the sidecar is rewritten with clamped tracks and handed back as `clampedDoc` for the caller's in-memory patch. */
export async function resyncFollowMediaDuration(
  slug: string,
  index: number,
  doc: SceneDoc | undefined,
  currentDurationMs: number,
  sceneFile?: string,
  /** The module at `index`, guarding the manifest write when `sceneFile` is omitted. */
  manifestFile?: string,
): Promise<{ wrote: boolean; clampedDoc: SceneDoc | null }> {
  const slots = followMediaSlots(doc);
  if (slots.length === 0) return { wrote: false, clampedDoc: null };
  const probed = new Map<string, number>();
  for (const { src } of slots) {
    if (probed.has(src)) continue;
    probed.set(src, (await invoke<MediaMetaLike>("media_meta", { slug, rel: src })).durationMs);
  }
  const meta = { durationMs: followMediaDurationMs(slots, probed) };
  if (meta.durationMs > 0 && meta.durationMs !== currentDurationMs) {
    await updateSceneDuration(slug, index, meta.durationMs, sceneFile ?? manifestFile);
    let clampedDoc: SceneDoc | null = null;
    if (doc && sceneFile && meta.durationMs < currentDurationMs) {
      clampedDoc = clampDocTracksToDuration(doc, meta.durationMs);
      if (clampedDoc) await writeSceneDoc(slug, sceneFile, clampedDoc, sceneDocBase(doc));
    }
    return { wrote: true, clampedDoc };
  }
  return { wrote: false, clampedDoc: null };
}

/** Shrink-fit every keyed track (camera, the layered-screenshot animation, the compare divider and the chart data) and the still marks to a new duration; null when nothing overhangs, so callers can skip the write. */
export function clampDocTracksToDuration(doc: SceneDoc, durationMs: number): SceneDoc | null {
  const cam = doc.camera
    ? clampTrackToDuration(doc.camera as KeyedTrack<unknown>, durationMs)
    : null;
  const anim = doc.layeredScreenshot?.animation
    ? clampTrackToDuration(doc.layeredScreenshot.animation as KeyedTrack<unknown>, durationMs)
    : null;
  const cmp = doc.compare?.track
    ? clampTrackToDuration(doc.compare.track as KeyedTrack<unknown>, durationMs)
    : null;
  const chart = doc.chart?.track
    ? clampTrackToDuration(doc.chart.track as KeyedTrack<unknown>, durationMs)
    : null;
  const camChanged = cam !== null && cam !== (doc.camera as KeyedTrack<unknown>);
  const animChanged =
    anim !== null && anim !== (doc.layeredScreenshot?.animation as KeyedTrack<unknown>);
  const cmpChanged = cmp !== null && cmp !== (doc.compare?.track as KeyedTrack<unknown>);
  const chartChanged = chart !== null && chart !== (doc.chart?.track as KeyedTrack<unknown>);
  const stills = clampStillMarks(doc.stills, durationMs);
  const stillsChanged = stills !== doc.stills;
  if (!camChanged && !animChanged && !cmpChanged && !chartChanged && !stillsChanged) return null;
  const next = structuredClone(doc);
  if (camChanged && next.camera) {
    const before = new Map(doc.camera?.keys.map((k) => [k.id, k.tMs]));
    next.camera = structuredClone(cam) as NonNullable<SceneDoc["camera"]>;
    // A clamped key left its musical position, so it detaches.
    for (const key of next.camera.keys) {
      if (key.at !== undefined && before.get(key.id) !== key.tMs) delete key.at;
    }
  }
  if (animChanged && next.layeredScreenshot) {
    next.layeredScreenshot.animation = structuredClone(anim) as NonNullable<
      SceneDoc["layeredScreenshot"]
    >["animation"];
  }
  if (cmpChanged && next.compare) {
    next.compare.track = structuredClone(cmp) as NonNullable<SceneDoc["compare"]>["track"];
  }
  if (chartChanged && next.chart) {
    next.chart.track = structuredClone(chart) as NonNullable<SceneDoc["chart"]>["track"];
  }
  if (stillsChanged && stills) next.stills = structuredClone(stills);
  return next;
}

/** Re-syncs every follow-media scene in a project (the `kookaburra://media-changed` sweep); workspace projects only, since bundled gate projects keep manual durations. Returns whether any scene's duration was rewritten so the caller can schedule a timing refresh. Deliberately omits `sceneFile`, so this background path never clamps keyframe tracks: an event-driven sweep must not delete keys with no undo entry; the user-gesture paths (duration commits, media swaps) carry the clamp with history. */
export async function syncFollowMediaDurations(project: LoadedProject): Promise<boolean> {
  if (!isEditableProjectId(project.id)) return false;
  const slug = nativeProjectSlug(project.id);
  let wrote = false;
  for (let i = 0; i < project.sceneDocs.length; i++) {
    try {
      const result = await resyncFollowMediaDuration(
        slug,
        i,
        project.sceneDocs[i],
        project.slots[i].durationMs,
        undefined,
        project.sceneFiles[i],
      );
      if (result.wrote) wrote = true;
    } catch (e) {
      console.warn(`[sceneDoc] duration-follow probe failed for scene ${i}:`, e);
    }
  }
  return wrote;
}
