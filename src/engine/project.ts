import { useTexture } from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";
import type { ComponentType } from "react";
import { TextureLoader } from "three";
import { collectThemeFontRefs, preloadAppFonts } from "../theme/fonts";
import { resolveTheme } from "../theme/registry";
import type { EffectsConfig, EffectsOverride, Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { preloadEmojiRasters } from "../toolkit/text/emojiRaster";
import type { SceneModule } from "../toolkit/types";
import type { CameraKeyframe } from "./cameraTrack";
import { preloadEffectLuts } from "./effects";
import { mergeFrameSpec, parseFrameSpec } from "./frameSchema";
import { fsUrl } from "./media";
import { ensureProjectTrusted } from "./projectTrust";
import { ensureSampleAssets } from "./sampleAssets";
import { compileSceneModule } from "./sceneCompiler";
import { loadSceneDoc } from "./sceneDoc";
import { collectSceneDocFontRefs, type SceneDoc } from "./sceneDocSchema";
import {
  buildSceneTimeline,
  type SceneSlot,
  type TransitionSpec,
  timelineTotalMs,
} from "./sceneTimeline";
import { ensureFontRefsPinned } from "./systemFonts";

/** On-disk project manifest (`projects/<id>/project.json`). */
export interface ProjectManifest {
  id: string;
  name: string;
  /** Per-project soundtrack: assets-relative file + mix params, muxed at export. */
  audio?: ProjectAudioSpec;
  /** Theme to apply, matched against `Theme.id` (`kookaburra-*` bundled, `ws:<slug>` user). */
  themeId: string;
  /** Aspect ratios this project targets. */
  formats: string[];
  /** Manifest schema version; absent = 1. v2 flips transition ownership to the outgoing scene. */
  version?: number;
  /** Ordered scenes; `transition` (optional) is how a scene EXITS into the next one (v2). Legacy unversioned files stored it on the incoming scene; `outgoingSceneTransitions` shifts them so both render identically. */
  scenes: {
    file: string;
    durationMs: number;
    transition?: TransitionSpec;
    /** Per-scene postprocessing overrides layered on the project-wide (theme) effects. */
    effects?: EffectsOverride;
  }[];
  /** Per-project camera keyframes on the GLOBAL clock, applied at the shared render seam (engine/cameraTrack.ts). Absent means the camera is never touched (the v0-v2 byte-identical path). */
  camera?: CameraKeyframe[];
  /** Project-relative module path (e.g. `"scenes/persistent-orb.tsx"`) whose default export is a plain component hosted OUTSIDE every scene in a `<PersistentLayer>`; it reads global time and morphs across scene seams. Absent means no persistent layer (byte-identical path). */
  persistent?: string;
  /** Deck-wide overlay: a camera-locked panel with a shaped cutout the scene renders through, merged with each scene's sidecar `frame` (see `mergeFrameSpec`). Absent means no overlay anywhere, the byte-identical legacy path. */
  frame?: FrameSpec;
}

/** Manifest transitions in outgoing terms: v2 reads them straight off each scene; legacy unversioned files stored each transition on the incoming scene, so they shift one scene earlier, which reproduces the exact pre-v2 timeline. */
export function outgoingSceneTransitions(
  manifest: Pick<ProjectManifest, "version" | "scenes">,
): (TransitionSpec | undefined)[] {
  if ((manifest.version ?? 1) >= 2) return manifest.scenes.map((s) => s.transition);
  return manifest.scenes.map((_, i) => manifest.scenes[i + 1]?.transition);
}

/** A project with its scene modules imported and theme resolved, ready to render/export. */
/** The project.json `audio` block, as authored. */
export interface ProjectAudioSpec {
  /** Assets-relative path (the house rule; never absolute/remote). */
  file: string;
  gainDb?: number;
  fadeInMs?: number;
  /** Omitted → DEFAULT_AUDIO_FADE_OUT_MS at the timeline's end; an explicit 0 opts out. */
  fadeOutMs?: number;
  startOffsetMs?: number;
}

/** The loaded soundtrack: the spec plus the resolved path and probed stream facts. */
export interface ProjectAudio extends ProjectAudioSpec {
  abs: string;
  durationMs: number;
  sampleRate: number;
}

/** Every soundtrack fades out smoothly over the last second of the TIMELINE unless project.json says otherwise (`fadeOutMs: 0` disables; any value overrides). Resolved here so preview and export read the same object and can never disagree. */
export const DEFAULT_AUDIO_FADE_OUT_MS = 1000;

/** The authored spec with house defaults applied (exported for tests). */
export function withAudioDefaults(spec: ProjectAudioSpec): ProjectAudioSpec {
  return { ...spec, fadeOutMs: spec.fadeOutMs ?? DEFAULT_AUDIO_FADE_OUT_MS };
}

export interface LoadedProject {
  id: string;
  name: string;
  theme: Theme;
  scenes: SceneModule[];
  /** Overlap-aware placement of each scene on the global timeline (sequencing source of truth). */
  slots: SceneSlot[];
  /** Total project length = Σ(durations) − Σ(overlaps), in milliseconds. */
  totalMs: number;
  /** Project-wide postprocessing default (from the theme; empty = no effects → composer-free path). */
  effects: EffectsConfig;
  /** Per-scene effect overrides, keyed by scene index. Empty when no scene overrides effects. */
  effectOverrides: Record<number, EffectsOverride>;
  /** The project's camera keyframe track, if it declares one (manifest `camera`). */
  cameraTrack?: CameraKeyframe[];
  /** The project's persistent (hoisted morph) component, if it declares one (manifest `persistent`). */
  persistent?: ComponentType;
  /** Per-scene sidecar documents, index-parallel to `scenes` and keyed off each manifest entry's FILE stem (`scenes/01-hero.tsx` → `scenes/01-hero.json`). Undefined entries are scenes without a sidecar, rendering as before with no editing affordances; the engine reads these directly, scene components via `SceneHost`'s `SceneDocContext`. */
  sceneDocs: (SceneDoc | undefined)[];
  /** The manifest's per-scene module paths (`scenes/01-hero.tsx`), index-parallel to `scenes`; the stable file identity behind sidecar writes and thumb caching (scene ids are TSX-authored and free to collide/rename, files are unique). */
  sceneFiles: string[];
  /** Each scene's RESOLVED theme, index-parallel to `scenes`: the project theme unless the scene's sidecar overrides `themeId`. `SceneHost` provides it to the scene's tree; render seams read it for per-scene state (background/environment). */
  sceneThemes: Theme[];
  /** Each scene's RESOLVED overlay, index-parallel to `scenes`: the manifest's deck frame merged with the sidecar's override, `undefined` where the scene has no frame or opted out. Every entry undefined means the project never enters the overlay render path. */
  sceneFrames: (FrameSpec | undefined)[];
  /** Present only when the manifest declares (and the probe accepted) a soundtrack. */
  audio?: ProjectAudio;
  /** BASE effect stacks for scenes whose sidecar swaps the theme (sparse, keyed by scene index); a wholesale replacement of the project default for that scene, LUT urls already resolved. See `sceneBaseEffects` (engine/effectParams.ts). */
  sceneEffectDefaults: Record<number, EffectsConfig>;
}

/** A scene file's stem; the sidecar/thumb cache key (`scenes/01-hero.tsx` → `01-hero`). */
export function sceneFileStem(file: string): string {
  return file.replace(/^scenes\//, "").replace(/\.tsx$/, "");
}

// Vite resolves these globs from the repo root (the dev/build root). Manifests are small so they load on demand; scene modules are lazy and imported per project.
const manifestGlob = import.meta.glob<{ default: ProjectManifest }>("/projects/*/project.json");
const sceneGlob = import.meta.glob<{ default: SceneModule }>("/projects/*/scenes/*.tsx");
// Persistent (hoisted morph) modules share the scenes/ folder but default-export a plain component rather than a defineScene, hence the separately-typed glob over the same files.
const persistentGlob = import.meta.glob<{ default: ComponentType }>("/projects/*/scenes/*.tsx");
// Scene sidecar documents live beside their TSX as `scenes/<stem>.json`.
const sceneDocGlob = import.meta.glob<{ default: unknown }>("/projects/*/scenes/*.json");

// Project-relative IMAGE assets, resolved to Vite-fingerprinted URLs that load inside the webview (textures for DeviceMockup screens, etc.); eager so the map is available synchronously during render. Scoped to images: video sources resolve to an absolute path (`resolveAssetPath`) for ffmpeg pre-extraction, not fetched as URLs.
const assetUrlGlob = import.meta.glob<string>("/projects/*/assets/**/*.{png,jpg,jpeg,webp}", {
  query: "?url",
  import: "default",
  eager: true,
});

/** Dev-only lab projects stay out of every picker; `loadProject` still resolves them by id (the option-preview generator loads `preview-lab` explicitly). */
const HIDDEN_PROJECT_IDS = new Set(["preview-lab"]);

/** Project ids discoverable under `projects/`. */
export function listProjectIds(): string[] {
  return Object.keys(manifestGlob)
    .map((path) => path.split("/")[2])
    .filter((id) => !HIDDEN_PROJECT_IDS.has(id));
}

// ── Workspace projects ─────────────────────────────────────────────────────
// User projects live in the workspace (~/Kookaburra Cut by default), outside the bundle. Scene modules compile at runtime (esbuild-wasm, engine/sceneCompiler.ts) and assets load over Tauri's asset protocol, ONE loader for dev and packaged. Their project ids carry a `ws:` prefix so a project can never collide with a bundled project of the same name.

export const WORKSPACE_PROJECT_PREFIX = "ws:";

/** One entry in the combined project picker. */
export interface ProjectListing {
  id: string;
  name: string;
  source: "bundled" | "workspace";
}

interface WorkspaceProject {
  slug: string;
  name: string;
  /** Absolute project folder path (the native side owns workspace-root resolution). */
  path: string;
}

/** Workspace projects by slug; refreshed by `listAllProjects`/`loadProject`, read synchronously by the asset resolvers (valid because `loadProject` always refreshes before scenes render). */
let workspaceProjects = new Map<string, WorkspaceProject>();

export function isWorkspaceProjectId(id: string): boolean {
  return id.startsWith(WORKSPACE_PROJECT_PREFIX);
}

/** Absolute folder of a cached workspace project (valid once its project has loaded). */
export function workspaceProjectPath(slug: string): string | null {
  return workspaceProjects.get(slug)?.path ?? null;
}

/** The project slug of a workspace project id (`"ws:my-video"` → `"my-video"`). */
export function workspaceSlug(id: string): string {
  return id.slice(WORKSPACE_PROJECT_PREFIX.length);
}

/** Bumped when project sources change on disk (App's fingerprint poll): keys the compiled-module cache, so a bump re-reads + recompiles every scene module while unchanged loads reuse theirs (UI writes never bump it). */
let workspaceReloadToken = 0;

export function bumpWorkspaceReloadToken(): void {
  workspaceReloadToken += 1;
}

function requireWorkspaceProject(slug: string): WorkspaceProject {
  const project = workspaceProjects.get(slug);
  if (!project) {
    throw new Error(
      `Workspace project "${slug}" not found — it may have been renamed or deleted. ` +
        `Known projects: ${[...workspaceProjects.keys()].join(", ") || "none"}.`,
    );
  }
  return project;
}

/** Re-scan the workspace (no workspace configured / native errors read as "no projects"). */
async function refreshWorkspaceProjects(): Promise<WorkspaceProject[]> {
  try {
    const settings = await invoke<{ workspaceRoot: string | null }>("get_settings");
    if (!settings.workspaceRoot) return [];
    const projects = await invoke<WorkspaceProject[]>("list_projects");
    workspaceProjects = new Map(projects.map((p) => [p.slug, p]));
    return projects;
  } catch (e) {
    console.warn("[workspace] listing projects failed:", e);
    return [];
  }
}

/** Everything the project picker shows: workspace projects first, then bundled projects. */
export async function listAllProjects(): Promise<ProjectListing[]> {
  const workspace = (await refreshWorkspaceProjects()).map<ProjectListing>((p) => ({
    id: `${WORKSPACE_PROJECT_PREFIX}${p.slug}`,
    name: p.name,
    source: "workspace",
  }));
  const bundled = listProjectIds().map<ProjectListing>((id) => ({
    id,
    name: id,
    source: "bundled",
  }));
  return [...workspace, ...bundled];
}

// The absolute projects root the native side reads assets from. Dev: the repo tree, baked in by Vite (vite.config.ts). Packaged: resolved once from the .app's bundled resources (`bundle.resources` in tauri.conf.json maps ../projects → Resources/projects).
let projectsRoot: string | null = import.meta.env.DEV ? __PROJECTS_DIR__ : null;

/** Resolve the projects root exactly once. A no-op in dev; in a packaged app it asks Tauri for the resource dir. `loadProject` awaits this before returning, so every consumer of `resolveAssetPath` (clip extraction, hashing) runs after the root is known. */
async function ensureProjectsRoot(): Promise<void> {
  if (projectsRoot) return;
  projectsRoot = await join(await resourceDir(), "projects");
}

/** Reject a project-relative path that could escape the project folder: no absolute paths, no ".." segments, never empty. Mirrors the intent of Rust's `media::resolve_asset` (frontend defence in depth; the native side stays the hard boundary). Returns the path with a leading "./" stripped. */
export function assertProjectRelative(rel: string): string {
  if (!rel) throw new Error("Asset path is empty.");
  if (rel.startsWith("/")) {
    throw new Error(`Asset path "${rel}" is absolute; expected a project-relative path.`);
  }
  const clean = rel.replace(/^\.\//, "");
  if (clean.split("/").some((part) => part === "..")) {
    throw new Error(`Asset path "${rel}" has a ".." segment, which is not allowed.`);
  }
  return clean;
}

/** Resolve a project-relative asset path (e.g. `"assets/clip.mp4"`) to an absolute filesystem path so the native side can read it (ffmpeg pre-extraction, hashing). Valid only after a project has loaded (which resolves the packaged-app root; see `ensureProjectsRoot`). Rejects paths that could escape the project folder (see `assertProjectRelative`). */
export function resolveAssetPath(projectId: string, relPath: string): string {
  const clean = assertProjectRelative(relPath);
  if (isWorkspaceProjectId(projectId)) {
    return `${requireWorkspaceProject(workspaceSlug(projectId)).path}/${clean}`;
  }
  if (!projectsRoot) {
    throw new Error("Projects root not resolved yet — load a project before resolving assets.");
  }
  return `${projectsRoot}/${projectId}/${clean}`;
}

/** The URL key a project-relative asset loads under: bundled projects use their `import.meta.glob` key (the project-root-absolute path); workspace projects use an asset-protocol URL (one seam for dev and packaged). */
function projectAssetKey(projectId: string, relPath: string): string {
  const clean = relPath.replace(/^\.?\//, "");
  if (isWorkspaceProjectId(projectId)) {
    return fsUrl(`${requireWorkspaceProject(workspaceSlug(projectId)).path}/${clean}`);
  }
  return `/projects/${projectId}/${clean}`;
}

/** Resolve every `lut.url` in an effect config from project-relative (how project.json/themes author it) to its project glob key (how engine/effects.ts loads and caches it). Pure; returns fresh objects, never mutates (the theme's EffectsConfig is a shared module value). */
function resolveLutUrls<T extends EffectsConfig | EffectsOverride>(projectId: string, cfg: T): T {
  if (!cfg.lut?.url) return cfg;
  return { ...cfg, lut: { ...cfg.lut, url: projectAssetKey(projectId, cfg.lut.url) } };
}

/** Resolve a project-relative IMAGE asset (e.g. `"assets/screen.png"`) to a Vite-fingerprinted URL loadable inside the webview (for a WebGL texture). Unlike `resolveAssetPath` (an absolute FS path for the native side), this is a bundled asset URL that survives the `base: "./"` packaged build. Throws with an actionable message if the asset is missing. */
export function resolveAssetUrl(projectId: string, relPath: string): string {
  const key = projectAssetKey(projectId, relPath);
  // Workspace assets load at their asset-protocol key directly.
  if (isWorkspaceProjectId(projectId)) return key;
  const url = assetUrlGlob[key];
  if (!url) {
    throw new Error(
      `Image asset "${relPath}" not found for project "${projectId}" (looked for ${key}). ` +
        "Put it under projects/<project>/assets/ and reference it relatively.",
    );
  }
  return url;
}

/** Await every image asset of a project being fetched + decoded before frame 0, warming drei's `useTexture` cache so screen textures (e.g. DeviceMockup) resolve synchronously in the export loop. Called in the export preamble; video sources are handled separately by `preextractClips`. See docs/determinism.md. */
export async function preloadProjectImages(projectId: string): Promise<void> {
  let urls: string[];
  if (isWorkspaceProjectId(projectId)) {
    // The workspace equivalent of the eager glob: ask the native side for the project's image assets and load them at their asset-protocol URLs.
    const slug = workspaceSlug(projectId);
    const rels = await invoke<string[]>("list_project_assets", { slug });
    urls = rels.map((rel) => projectAssetKey(projectId, rel));
  } else {
    const prefix = `/projects/${projectId}/`;
    urls = Object.entries(assetUrlGlob)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, url]) => url);
  }
  if (urls.length === 0) return;
  const loader = new TextureLoader();
  await Promise.all(
    urls.map(async (url) => {
      useTexture.preload(url); // warm drei's suspense cache
      await loader.loadAsync(url); // awaitable barrier
    }),
  );
}

/** Load a project by id: parse its manifest, import each referenced scene module, and resolve its theme. Scene durations come from the manifest (the sequencing source of truth). Throws with an actionable message if the project, a scene, or the scene's default export is missing/malformed. */
/** Compiled workspace modules, keyed `slug/file@token`: a module is reused until the reload token bumps (UI writes never bump it). Rejections evict themselves so a fixed scene recompiles on the next load. */
const wsCompiledModules = new Map<string, Promise<unknown>>();

async function importCompiledWorkspaceModule<T>(slug: string, file: string): Promise<T> {
  const key = `${slug}/${file}@${workspaceReloadToken}`;
  let pending = wsCompiledModules.get(key);
  if (!pending) {
    pending = (async () => {
      const source = await invoke<string>("read_scene_source", { slug, file });
      const url = await compileSceneModule(source, file);
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        // The module is fully instantiated once the import resolves; the URL is done.
        URL.revokeObjectURL(url);
      }
    })();
    wsCompiledModules.set(key, pending);
    pending.catch(() => wsCompiledModules.delete(key));
  }
  return (await pending) as T;
}

/** Import a project-relative TSX module. Bundled projects resolve through the compile-time glob; workspace projects compile at runtime (esbuild-wasm, one loader for dev and packaged; the dev-server `/@fs` module path was retired once proved hash-equal to the compiled path). */
async function importProjectModule<T>(
  glob: Record<string, () => Promise<T>>,
  projectId: string,
  file: string,
  what: string,
): Promise<T> {
  if (isWorkspaceProjectId(projectId)) {
    const project = requireWorkspaceProject(workspaceSlug(projectId));
    return importCompiledWorkspaceModule<T>(project.slug, file.replace(/^\.?\//, ""));
  }
  const path = `/projects/${projectId}/${file}`;
  const load = glob[path];
  if (!load) {
    throw new Error(`${what} "${path}" not found (referenced by ${projectId}/project.json).`);
  }
  return load();
}

/** Parse a project manifest from either source, with readable failures for hand-edited files. */
async function loadManifest(id: string): Promise<ProjectManifest> {
  if (isWorkspaceProjectId(id)) {
    const slug = workspaceSlug(id);
    if (!workspaceProjects.has(slug)) await refreshWorkspaceProjects();
    requireWorkspaceProject(slug);
    const text = await invoke<string>("read_project_manifest", { slug });
    let manifest: ProjectManifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      throw new Error(`"${slug}/project.json" isn't valid JSON (${e}). Ask Claude to fix it.`);
    }
    if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      throw new Error(`"${slug}/project.json" needs a non-empty "scenes" array.`);
    }
    return manifest;
  }
  const manifestPath = `/projects/${id}/project.json`;
  const load = manifestGlob[manifestPath];
  if (!load) {
    throw new Error(
      `Project "${id}" not found (no ${manifestPath}). Available: ${listProjectIds().join(", ") || "none"}`,
    );
  }
  return (await load()).default;
}

/** `options.themeId` overrides the manifest's project theme for this LOAD ONLY (the theme-preview pipeline renders `theme-starter` once per theme this way); it replaces the project-level theme (and so every scene without its own sidecar `themeId`), and nothing is written to disk. */
export async function loadProject(
  id: string,
  options?: { themeId?: string },
): Promise<LoadedProject> {
  await ensureProjectsRoot();
  const manifest = await loadManifest(id);

  // F-001 trust gate: no workspace scene code compiles until the user consents; bundled projects never gate. Reading the manifest above is inert (JSON only).
  if (isWorkspaceProjectId(id)) {
    const slug = workspaceSlug(id);
    await ensureProjectTrusted(slug, manifest.name || slug);
    await ensureSampleAssets(slug);
  }

  const scenes: SceneModule[] = [];
  for (const entry of manifest.scenes) {
    const scene = (
      await importProjectModule<{ default: SceneModule }>(sceneGlob, id, entry.file, "Scene")
    ).default;
    if (!scene || typeof scene.Scene !== "function") {
      throw new Error(
        `Scene "${entry.file}" must default-export defineScene({ id, durationMs, Scene }).`,
      );
    }
    // The manifest's durationMs is authoritative for sequencing.
    scenes.push({ ...scene, durationMs: entry.durationMs ?? scene.durationMs });
  }

  // Sidecar scene documents, keyed off each entry's file stem; missing → undefined.
  const sceneDocs = await Promise.all(
    manifest.scenes.map((entry) => loadSceneDoc(id, entry.file, sceneDocGlob)),
  );

  // Overlap-aware placement: a transition pulls the next scene's start back, shortening the project.
  const outgoing = outgoingSceneTransitions(manifest);
  const slots = buildSceneTimeline(
    manifest.scenes.map((_, i) => ({
      id: scenes[i].id,
      durationMs: scenes[i].durationMs,
      transition: outgoing[i],
    })),
  );
  const totalMs = timelineTotalMs(slots);
  const theme = await resolveTheme(options?.themeId ?? manifest.themeId);

  // Per-scene theme resolution: a sidecar `themeId` swaps the WHOLE theme for that scene; unknown ids fall back to the project's theme, scenes without an override share the project theme object.
  const sceneThemes = await Promise.all(
    sceneDocs.map((doc) => (doc?.themeId ? resolveTheme(doc.themeId, theme) : theme)),
  );

  // Per-scene overlay resolution: the sidecar's frame merges over the manifest's deck frame; a scene that resolves to `enabled:false` drops out so it renders full-bleed. The manifest is raw JSON.parse, so its frame parses here (sidecar frames already parsed through `parseSceneDoc`).
  const deckFrame =
    manifest.frame === undefined ? undefined : parseFrameSpec(manifest.frame, `${id}/project.json`);
  const sceneFrames = sceneDocs.map((doc) => {
    const merged = mergeFrameSpec(deckFrame, doc?.frame);
    return merged?.enabled === false ? undefined : merged;
  });

  // System-font auto-pin: resolve every theme font (and sidecar `<key>Font` overrides) BEFORE scenes render; bundled-only projects short-circuit without touching the native side.
  const fontRefs = [
    ...collectThemeFontRefs([theme, ...sceneThemes]),
    ...collectSceneDocFontRefs(sceneDocs),
  ];
  await ensureFontRefsPinned(fontRefs);

  // Pre-generate every project's glyphs BEFORE the scenes mount: troika's shared SDF atlas assigns cells in typeset order, so mount-time typesets racing font loads would claim cells in per-boot order (the showcase-tour ±LSB hash lottery); the sequential preload pins the atlas layout so scenes' own typesets find every glyph already generated. See theme/fonts.ts and docs/determinism.md ("Fonts").
  await preloadAppFonts(fontRefs);

  // Colour-emoji rasters for every sidecar string settle before scenes mount, and this pins which project's cache receives new rasters (mirrors the export preamble).
  await preloadEmojiRasters(id, sceneDocs);

  // Collect per-scene effect overrides (sparse, only scenes that declare `effects`), with any LUT urls resolved from project-relative to their project asset keys.
  const effectOverrides: Record<number, EffectsOverride> = {};
  manifest.scenes.forEach((entry, i) => {
    if (entry.effects) effectOverrides[i] = resolveLutUrls(id, entry.effects);
  });
  const effects = resolveLutUrls(id, theme.effects ?? {});

  // Theme-swapped scenes replace the project-wide effect base wholesale (sparse; entries only where a sidecar overrides the theme, possibly `{}`, which turns effects OFF there).
  const sceneEffectDefaults: Record<number, EffectsConfig> = {};
  sceneDocs.forEach((doc, i) => {
    if (doc?.themeId) sceneEffectDefaults[i] = resolveLutUrls(id, sceneThemes[i].effects ?? {});
  });

  // LUT textures must be cached before the effects store publishes them; the composer chain builds synchronously on the next rendered frame. (The export preamble re-awaits; no-op.)
  await preloadEffectLuts({
    effects,
    overrides: effectOverrides,
    sceneDefaults: sceneEffectDefaults,
  });

  // Resolve the persistent (hoisted morph) module, if the project declares one.
  let persistent: ComponentType | undefined;
  if (manifest.persistent) {
    persistent = (
      await importProjectModule<{ default: ComponentType }>(
        persistentGlob,
        id,
        manifest.persistent,
        "Persistent module",
      )
    ).default;
    if (typeof persistent !== "function") {
      throw new Error(
        `Persistent module "${manifest.persistent}" must default-export a component.`,
      );
    }
  }

  // The soundtrack: resolve + probe, degrade-never-crash; a missing or unprobeable file loads the project SILENT with a warning (the malformed-theme rule).
  let audio: ProjectAudio | undefined;
  if (manifest.audio?.file) {
    try {
      const abs = resolveAssetPath(id, manifest.audio.file);
      const probe = await invoke<{ durationMs: number; sampleRate: number }>("probe_audio", {
        path: abs,
      });
      audio = { ...withAudioDefaults(manifest.audio), abs, ...probe };
      const covered = audio.durationMs - (audio.startOffsetMs ?? 0);
      if (covered < totalMs) {
        console.warn(
          `[project] soundtrack covers ${covered}ms of a ${totalMs}ms project — the tail pads with silence`,
        );
      }
    } catch (e) {
      console.warn(
        `[project] soundtrack "${manifest.audio.file}" unavailable — loading silent:`,
        e,
      );
    }
  }

  return {
    // Workspace projects keep their prefixed id; every asset resolver routes on it.
    id: isWorkspaceProjectId(id) ? id : manifest.id,
    name: manifest.name,
    theme,
    scenes,
    slots,
    totalMs,
    effects,
    effectOverrides,
    audio,
    cameraTrack: manifest.camera,
    persistent,
    sceneDocs,
    sceneFiles: manifest.scenes.map((entry) => entry.file),
    sceneThemes,
    sceneFrames,
    sceneEffectDefaults,
  };
}
