import { invoke } from "@tauri-apps/api/core";
import { useContext, useLayoutEffect, useMemo } from "react";
import type { DeviceId } from "../toolkit/device/catalog";
import type { DeviceProps } from "../toolkit/device/Device";
import { useDeviceRegistry } from "./deviceRegistry";
import { type HistoryChange, pushHistory } from "./history";
import { useLayeredScreenshotRegistry } from "./layeredScreenshotRegistry";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "./project";
import { SceneDocContext, useSceneContext } from "./sceneContext";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";
import {
  type NormalizedLayeredScreenshot,
  normalizeLayeredScreenshot,
} from "./sceneLayeredScreenshot";
import { useTextKeyRegistry } from "./textKeyRegistry";

/** Scene-document IO and hooks: docs load beside their scene modules in `loadProject` into `LoadedProject.sceneDocs` and reach components via `SceneHost`'s `SceneDocContext`, but the engine (camera sampling, duration sync) reads `LoadedProject.sceneDocs` directly so export never touches React context or the editor store; schema and validation live in `sceneDocSchema.ts`. */

/** Loads the sidecar beside a manifest scene entry, keyed off the manifest file (never the TSX's `defineScene` id, which may differ from the stem); missing is the normal case and returns undefined. Workspace reads go through `invoke` every time so the fingerprint-poll reload always sees fresh content. */
export async function loadSceneDoc(
  projectId: string,
  sceneFile: string,
  bundledDocs: Record<string, () => Promise<{ default: unknown }>>,
): Promise<SceneDoc | undefined> {
  const docFile = sceneFile.replace(/\.tsx$/, ".json");
  if (docFile === sceneFile) return undefined;
  if (isWorkspaceProjectId(projectId)) {
    const slug = workspaceSlug(projectId);
    try {
      const text = await invoke<string | null>("read_scene_doc", { slug, file: docFile });
      if (text == null) return undefined;
      return parseSceneDoc(JSON.parse(text), `${slug}/${docFile}`);
    } catch (e) {
      console.warn(`[sceneDoc] reading ${slug}/${docFile} failed:`, e);
      return undefined;
    }
  }
  const key = `/projects/${projectId}/${docFile}`;
  const load = bundledDocs[key];
  if (!load) return undefined;
  return parseSceneDoc((await load()).default, key);
}

// ── Hooks (inside the canvas subtree, via SceneHost's SceneDocContext) ──────────

/** The mounted scene's document, or null when it has none. */
export function useSceneDoc(): SceneDoc | null {
  return useContext(SceneDocContext);
}

/** A user-visible string from the scene document's text map; the authoring skill mandates all user-visible strings route through this so "Edit text" works on any scene, falling back when the doc, map, or key is absent. */
export function useSceneText(key: string, fallback = ""): string {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  // Layout effect so TextFallback's render gate settles in the same commit, never a painted frame late.
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useTextKeyRegistry.getState().register(sceneIndex, key);
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, key);
  }, [sceneIndex, key]);
  return doc?.text?.[key] ?? fallback;
}

/** `Device`-spreadable props (the sidecar device entry, with `model` narrowed). */
export interface SceneDeviceProps extends Omit<DeviceProps, "model"> {
  id: string;
  model: DeviceId;
}

/** The scene document's devices array as `Device`-ready props; unknown models pass through since `Device` itself degrades (console error + fallback geometry) rather than crashing the tree. */
export function useSceneDevices(): SceneDeviceProps[] {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  // Layout effect so DevicesFallback's render gate settles in the same commit, never a painted frame late.
  useLayoutEffect(() => {
    if (sceneIndex === undefined) return;
    useDeviceRegistry.getState().register(sceneIndex);
    return () => useDeviceRegistry.getState().unregister(sceneIndex);
  }, [sceneIndex]);
  return (doc?.devices ?? []).map((d) => d as SceneDeviceProps);
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

// ── Sidecar writes (shared by the wizards and the edit bar) ────────────────────

/** Atomic, version-guarded sidecar write via the native command. */
export async function writeSceneDoc(slug: string, sceneFile: string, doc: SceneDoc): Promise<void> {
  await invoke("write_scene_doc", {
    slug,
    file: sceneFile.replace(/\.tsx$/, ".json"),
    text: JSON.stringify(doc, null, 2),
  });
}

/** Stamps one scene's background + backdrop overrides onto every OTHER scene (raw fields, so "follow theme" copies as absence and named gradients still resolve per-scene): one compound undo entry, doc-less targets get a minimal doc, and a single bad scene loses only itself. Returns counts so the caller can surface partial failures. */
export async function applyBackgroundToAllScenes(
  project: LoadedProject,
  sourceIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
): Promise<{ applied: number; failed: number }> {
  if (!isWorkspaceProjectId(project.id)) return { applied: 0, failed: 0 };
  const slug = workspaceSlug(project.id);
  const source = project.sceneDocs[sourceIndex];
  const changes: HistoryChange[] = [];
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
      onDocChanged(i, next);
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
  if (changes.length > 0) {
    pushHistory({ label: "apply background to all scenes", changes });
  }
  return { applied: changes.length, failed };
}

// ── Duration-follow (engine-side; reads LoadedProject directly, never React context) ──

interface MediaMetaLike {
  durationMs: number;
}

/** Re-syncs one follow-media scene's `project.json` duration from its source video's probed length (no-op for manual mode, image, or missing media); returns whether `project.json` was rewritten so UI callers know a timing refresh is needed, since sidecar-only edits patch in memory and never reload. */
export async function resyncFollowMediaDuration(
  slug: string,
  index: number,
  doc: SceneDoc | undefined,
  currentDurationMs: number,
): Promise<boolean> {
  const duration = doc?.duration;
  if (duration?.mode !== "follow-media") return false;
  const devices = doc?.devices ?? [];
  const device = devices.find((d) => d.id === duration.sourceDeviceId) ?? devices[0];
  const media = device?.media;
  if (media?.kind !== "video") return false;
  const meta = await invoke<MediaMetaLike>("media_meta", { slug, rel: media.src });
  if (meta.durationMs > 0 && meta.durationMs !== currentDurationMs) {
    await invoke("update_project_scene", { slug, index, durationMs: meta.durationMs });
    return true;
  }
  return false;
}

/** Re-syncs every follow-media scene in a project (the `kookaburra://media-changed` sweep); workspace projects only, since bundled gate projects keep manual durations. Returns whether any scene's duration was rewritten so the caller can schedule a timing refresh. */
export async function syncFollowMediaDurations(project: LoadedProject): Promise<boolean> {
  if (!isWorkspaceProjectId(project.id)) return false;
  const slug = workspaceSlug(project.id);
  let wrote = false;
  for (let i = 0; i < project.sceneDocs.length; i++) {
    try {
      if (
        await resyncFollowMediaDuration(slug, i, project.sceneDocs[i], project.slots[i].durationMs)
      ) {
        wrote = true;
      }
    } catch (e) {
      console.warn(`[sceneDoc] duration-follow probe failed for scene ${i}:`, e);
    }
  }
  return wrote;
}
