import { invoke } from "@tauri-apps/api/core";
import { useContext, useId, useLayoutEffect, useMemo } from "react";
import type { DeviceId } from "../toolkit/device/catalog";
import type { DeviceProps } from "../toolkit/device/Device";
import { resolveDeviceLayout } from "../toolkit/device/layout";
import { useChartRegistry } from "./chartRegistry";
import { useDeviceRegistry } from "./deviceRegistry";
import { useFormat } from "./format";
import { type HistoryChange, pushHistory } from "./history";
import { clampTrackToDuration, type KeyedTrack } from "./keyedTrack";
import { useLayeredScreenshotRegistry } from "./layeredScreenshotRegistry";
import { type ManagedTextRenderRole, resolveTemplateManagedTextCopy } from "./managedText";
import { useObjectRegistry } from "./objectRegistry";
import {
  isWorkspaceBackedProjectId,
  isWorkspaceProjectId,
  type LoadedProject,
  nativeProjectSlug,
  type ProjectManifest,
  workspaceSlug,
} from "./project";
import { readProjectManifestSnapshot, writeProjectManifestSnapshot } from "./projectEdit";
import { type ResolvedChart, resolveChart } from "./sceneChart";
import { SceneDocContext, useSceneContext } from "./sceneContext";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import {
  type NormalizedLayeredScreenshot,
  normalizeLayeredScreenshot,
} from "./sceneLayeredScreenshot";
import { type NormalizedVideoWindow, normalizeVideoWindow } from "./sceneVideoWindow";
import { useTextKeyRegistry } from "./textKeyRegistry";
import { useVideoWindowRegistry } from "./videoWindowRegistry";

/** Scene-document IO and hooks: docs load beside their scene modules in `loadProject` into `LoadedProject.sceneDocs` and reach components via `SceneHost`'s `SceneDocContext`, but the engine (camera sampling, duration sync) reads `LoadedProject.sceneDocs` directly so export never touches React context or the editor store; schema and validation live in `sceneDocSchema.ts`. */

/** Loads the sidecar beside a manifest scene entry, keyed off the manifest file (never the TSX's `defineScene` id, which may differ from the stem); missing is the normal case and returns undefined. Workspace reads go through `invoke` every time so the fingerprint-poll reload always sees fresh content. `bundledDir` is the project's root-absolute glob folder (projects/ or the dev-only fixtures/ tree), so fixture sidecars resolve too. */
export async function loadSceneDoc(
  projectId: string,
  sceneFile: string,
  bundledDocs: Record<string, () => Promise<{ default: unknown }>>,
  bundledDir?: string,
): Promise<SceneDoc | undefined> {
  const docFile = sceneFile.replace(/\.tsx$/, ".json");
  if (docFile === sceneFile) return undefined;
  if (isWorkspaceBackedProjectId(projectId)) {
    const slug = nativeProjectSlug(projectId);
    try {
      const text = await invoke<string | null>("read_scene_doc", { slug, file: docFile });
      if (text == null) return undefined;
      return parseSceneDoc(JSON.parse(text), `${slug}/${docFile}`);
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

/** The scene document's videoWindow block, deep-validated, or null when absent; registers the scene as a consumer so `VideoWindowFallback` stands down (the useSceneLayeredScreenshot pattern). */
export function useSceneVideoWindow(): NormalizedVideoWindow | null {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useVideoWindowRegistry.getState().register(sceneIndex);
    return () => useVideoWindowRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  const block = doc?.videoWindow;
  return useMemo(
    () => normalizeVideoWindow(block, `scene ${sceneIndex ?? "?"}`),
    [block, sceneIndex],
  );
}

/** The scene document's chart block, fully resolved (defaults baked, data track sorted), or null when absent; registers the scene as a consumer so a host-mounted `ChartFallback` stands down (the useSceneVideoWindow pattern). */
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

const sceneDocWriteQueues = new Map<string, Promise<void>>();

/** Atomic, version-guarded sidecar write via the native command. */
export async function writeSceneDoc(slug: string, sceneFile: string, doc: SceneDoc): Promise<void> {
  const file = sceneFile.replace(/\.tsx$/, ".json");
  const key = `${slug}\u0000${file}`;
  const previous = sceneDocWriteQueues.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      await invoke("write_scene_doc", {
        slug,
        file,
        text: JSON.stringify(doc, null, 2),
      });
    });
  sceneDocWriteQueues.set(key, write);
  try {
    await write;
  } finally {
    if (sceneDocWriteQueues.get(key) === write) sceneDocWriteQueues.delete(key);
  }
}

/** Stamps one scene's background + backdrop overrides onto every OTHER scene (raw fields, so "follow theme" copies as absence and named gradients still resolve per-scene) AND onto the manifest as `appliedBackground`, so new scenes scaffold with the same look: one compound undo entry covering both, doc-less targets get a minimal doc, and a single bad scene loses only itself. Returns counts so the caller can surface partial failures. */
export async function applyBackgroundToAllScenes(
  project: LoadedProject,
  sourceIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc, sceneFile?: string) => void,
): Promise<{ applied: number; failed: number }> {
  if (!isWorkspaceProjectId(project.id)) return { applied: 0, failed: 0 };
  const slug = workspaceSlug(project.id);
  const source = project.sceneDocs[sourceIndex];
  const changes: HistoryChange[] = [];
  let applied = 0;
  let failed = 0;
  for (let i = 0; i < project.sceneFiles.length; i++) {
    if (i === sourceIndex) continue;
    const file = project.sceneFiles[i];
    if (!file) continue;
    const existing = project.sceneDocs[i];
    const next: SceneDoc = existing ? structuredClone(existing) : { version: 1 };
    next.background = source?.background ? structuredClone(source.background) : undefined;
    next.backdrop = source?.backdrop ? structuredClone(source.backdrop) : undefined;
    try {
      await writeSceneDoc(slug, file, next);
      onDocChanged(i, next, file);
      applied++;
      changes.push({
        kind: "sceneDoc",
        slug,
        file,
        sceneIndex: i,
        before: existing ? structuredClone(existing) : null,
        after: structuredClone(next),
      });
    } catch (e) {
      failed++;
      console.warn(`[sceneDoc] apply-background-to-all failed for scene ${i}:`, e);
    }
  }
  try {
    const before = await readProjectManifestSnapshot(slug);
    const manifest = JSON.parse(before) as ProjectManifest;
    const stamp: NonNullable<ProjectManifest["appliedBackground"]> = {};
    if (source?.background) stamp.background = structuredClone(source.background);
    if (source?.backdrop) stamp.backdrop = structuredClone(source.backdrop);
    const stamped = stamp.background !== undefined || stamp.backdrop !== undefined;
    // Applying a theme-default scene CLEARS the stamp, so new scenes go back to following the theme.
    if (stamped || manifest.appliedBackground !== undefined) {
      if (stamped) manifest.appliedBackground = stamp;
      else delete manifest.appliedBackground;
      await writeProjectManifestSnapshot(slug, JSON.stringify(manifest, null, 2));
      changes.push({
        kind: "manifest",
        slug,
        before,
        after: await readProjectManifestSnapshot(slug),
        reload: false,
      });
    }
  } catch (e) {
    console.warn("[sceneDoc] apply-background-to-all: manifest stamp failed:", e);
  }
  if (changes.length > 0) {
    pushHistory({ label: "apply background to all scenes", changes });
  }
  return { applied, failed };
}

/** Applies an edit-render re-point to a scene doc: the slot's media src becomes `rel` (the freshly rendered `assets/<name>-edited.mp4`). Pure clone-and-patch so App can write, patch in memory and record undo atomically; returns null when the slot has nothing to re-point. A `deviceId` targets that device alone (a stale id re-points nothing, never a neighbour); without one the first device keeps the legacy behaviour. */
export function applyEditRepoint(
  doc: SceneDoc,
  slot: "device" | "compareDevice" | "background" | "videoWindow",
  rel: string,
  deviceId?: string,
): SceneDoc | null {
  const next = structuredClone(doc);
  if (slot === "background") {
    if (next.background?.type !== "video") return null;
    next.background = { ...next.background, src: rel };
    return next;
  }
  if (slot === "videoWindow") {
    if (!next.videoWindow) return null;
    next.videoWindow = {
      ...next.videoWindow,
      media: { ...next.videoWindow.media, src: rel },
    };
    return next;
  }
  const device = deviceId ? next.devices?.find((d) => d.id === deviceId) : next.devices?.[0];
  if (!device) return null;
  if (slot === "compareDevice") {
    if (!next.compare) return null;
    const media = next.compare.b?.media?.[device.id] ?? device.media;
    if (!media) return null;
    next.compare.b = {
      ...next.compare.b,
      media: {
        ...next.compare.b?.media,
        [device.id]: { ...media, src: rel },
      },
    };
    return next;
  }
  if (!device.media) return null;
  device.media = { ...device.media, src: rel };
  return next;
}

// ── Duration-follow (engine-side; reads LoadedProject directly, never React context) ──

interface MediaMetaLike {
  durationMs: number;
}

/** The video sources a follow-media scene's duration derives from (pure so tests can pin it; the resync probes them all and follows the LONGEST). An explicit `source: "videoWindow"` or a matching `sourceDeviceId` pins one device; a comparison's `compare.b.media` videos count beside each device's own (both sides render, so neither recording may cut short); unpinned (or stale-pinned) docs return every qualifying video; device-less docs keep the videoWindow-then-background chain. */
export function followMediaSources(doc: SceneDoc | undefined): string[] {
  const duration = doc?.duration;
  if (duration?.mode !== "follow-media") return [];
  if (duration.source === "videoWindow") {
    return doc?.videoWindow?.media?.src ? [doc.videoWindow.media.src] : [];
  }
  const devices = doc?.devices ?? [];
  const pinned = devices.find((d) => d.id === duration.sourceDeviceId);
  const deviceVideos = (pinned ? [pinned] : devices).flatMap((d) => {
    const own = d.media?.kind === "video" ? [d.media.src] : [];
    const after = doc?.compare?.b?.media?.[d.id];
    return after?.kind === "video" ? [...own, after.src] : own;
  });
  if (deviceVideos.length > 0) return deviceVideos;
  if (doc?.videoWindow?.media?.src) return [doc.videoWindow.media.src];
  if (doc?.background?.type === "video") return [doc.background.src];
  return [];
}

/** Re-syncs one follow-media scene's `project.json` duration from its source videos' probed lengths (no-op for manual mode, image, or missing media); sources come from `followMediaSources`, the longest winning when more than one device video qualifies. `wrote` says `project.json` was rewritten so UI callers know a timing refresh is needed (sidecar-only edits patch in memory and never reload); when a shrink leaves keyframe tracks overhanging and `sceneFile` is given, the sidecar is rewritten with clamped tracks and handed back as `clampedDoc` for the caller's in-memory patch. */
export async function resyncFollowMediaDuration(
  slug: string,
  index: number,
  doc: SceneDoc | undefined,
  currentDurationMs: number,
  sceneFile?: string,
): Promise<{ wrote: boolean; clampedDoc: SceneDoc | null }> {
  const srcs = followMediaSources(doc);
  if (srcs.length === 0) return { wrote: false, clampedDoc: null };
  const meta = { durationMs: 0 };
  for (const src of srcs) {
    const probed = await invoke<MediaMetaLike>("media_meta", { slug, rel: src });
    if (probed.durationMs > meta.durationMs) meta.durationMs = probed.durationMs;
  }
  if (meta.durationMs > 0 && meta.durationMs !== currentDurationMs) {
    await invoke("update_project_scene", { slug, index, durationMs: meta.durationMs });
    let clampedDoc: SceneDoc | null = null;
    if (doc && sceneFile && meta.durationMs < currentDurationMs) {
      clampedDoc = clampDocTracksToDuration(doc, meta.durationMs);
      if (clampedDoc) await writeSceneDoc(slug, sceneFile, clampedDoc);
    }
    return { wrote: true, clampedDoc };
  }
  return { wrote: false, clampedDoc: null };
}

/** Shrink-fit every keyed track (camera, the layered-screenshot animation, the compare divider and the chart data) to a new duration; null when nothing overhangs, so callers can skip the write. */
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
  if (!camChanged && !animChanged && !cmpChanged && !chartChanged) return null;
  const next = structuredClone(doc);
  if (camChanged) next.camera = structuredClone(cam) as SceneDoc["camera"];
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
  return next;
}

/** Re-syncs every follow-media scene in a project (the `kookaburra://media-changed` sweep); workspace projects only, since bundled gate projects keep manual durations. Returns whether any scene's duration was rewritten so the caller can schedule a timing refresh. Deliberately omits `sceneFile`, so this background path never clamps keyframe tracks: an event-driven sweep must not delete keys with no undo entry; the user-gesture paths (duration commits, media swaps) carry the clamp with history. */
export async function syncFollowMediaDurations(project: LoadedProject): Promise<boolean> {
  if (!isWorkspaceProjectId(project.id)) return false;
  const slug = workspaceSlug(project.id);
  let wrote = false;
  for (let i = 0; i < project.sceneDocs.length; i++) {
    try {
      const result = await resyncFollowMediaDuration(
        slug,
        i,
        project.sceneDocs[i],
        project.slots[i].durationMs,
      );
      if (result.wrote) wrote = true;
    } catch (e) {
      console.warn(`[sceneDoc] duration-follow probe failed for scene ${i}:`, e);
    }
  }
  return wrote;
}
