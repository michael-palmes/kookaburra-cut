import {
  BackSide,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
} from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import cycloramaUrl from "../assets/hdri/cyclorama.hdr?url";
import dawnUrl from "../assets/hdri/dawn.hdr?url";
import ferndaleUrl from "../assets/hdri/ferndale-studio.hdr?url";
import interiorUrl from "../assets/hdri/interior.hdr?url";
import monochromeUrl from "../assets/hdri/monochrome-studio.hdr?url";
import nightCityUrl from "../assets/hdri/night-city.hdr?url";
import storyUrl from "../assets/hdri/story-studio.hdr?url";
import sunsetUrl from "../assets/hdri/sunset.hdr?url";
import warehouseUrl from "../assets/hdri/warehouse.hdr?url";
import type { FixtureSpec, LightingSpec, Theme } from "../theme/tokens";
import { fixtureWorldInstances } from "./fixtures";
import { resolveProjectHdrUrl } from "./project";
import { projectAssetRevision } from "./projectAssetRevision";
import type { SceneDoc } from "./sceneDocSchema";
import { resolveLighting, resolveLightingColour } from "./sceneLighting";

/** Environment reflections (IBL): PMREM textures cached by source key for the app's lifetime. Source kinds: bundled CC0 HDRIs (`kookaburra:<name>.hdr`, converted by `pnpm assets:hdri`; provenance in src/assets/hdri/README.md), the procedural `kookaburra:softbox` preset, `"none"` (explicitly no reflections, distinct from absent = inherit), and project-relative `.hdr`/`.exr` user files (cache-keyed `<projectId>|<rel>`; a missing file THROWS at resolve time so autoruns fail loudly, the AssetBoundary lesson). Determinism: RGBE/EXR decode is pure CPU and PMREM is fixed-function GPU work (the MSAA precedent), so it's same-machine deterministic; `preloadEnvironments` is an export-preamble barrier so every themed frame finds its texture already resolved, while the preview calls it too and simply invalidates when textures land. */

const BUNDLED_HDRI: Record<string, string> = {
  "kookaburra:ferndale-studio": ferndaleUrl,
  "kookaburra:monochrome-studio": monochromeUrl,
  "kookaburra:story-studio": storyUrl,
  "kookaburra:warehouse": warehouseUrl,
  "kookaburra:night-city": nightCityUrl,
  "kookaburra:sunset": sunsetUrl,
  "kookaburra:cyclorama": cycloramaUrl,
  "kookaburra:dawn": dawnUrl,
  "kookaburra:interior": interiorUrl,
};

export const SOFTBOX_SOURCE = "kookaburra:softbox";
export const NONE_SOURCE = "none";

/** The bundled picker order: the three shipped studios first, then the v9 additions. */
export const BUNDLED_ENVIRONMENT_IDS: readonly string[] = [
  "kookaburra:ferndale-studio",
  "kookaburra:monochrome-studio",
  "kookaburra:story-studio",
  "kookaburra:warehouse",
  "kookaburra:night-city",
  "kookaburra:sunset",
  "kookaburra:cyclorama",
  "kookaburra:dawn",
  "kookaburra:interior",
];

/** Resolved textures by cache key; `null` marks a source that failed/isn't wired (warned once). */
const loaded = new Map<string, Texture | null>();
const inflight = new Map<string, Promise<Texture | null>>();
const revisedSources = new Map<string, { projectId: string; rel: string }>();

/** The environments cache key for an authored source: bundled ids and "none" pass through; project-relative user paths key per project so two projects' "assets/studio.hdr" never collide. */
export function environmentCacheKey(projectId: string | undefined, source: string): string {
  if (source.startsWith("kookaburra:") || source === NONE_SOURCE) return source;
  const revision = projectAssetRevision(projectId);
  const key = `${projectId ?? ""}|${source}${revision ? `|${revision}` : ""}`;
  if (revision) revisedSources.set(key, { projectId: projectId ?? "", rel: source });
  return key;
}

/** The PMREM texture for a cache key, or null while loading / for unknown or "none" sources. Sync, called per render target at the compositor seam. */
export function getLoadedEnvironment(key: string): Texture | null {
  return loaded.get(key) ?? null;
}

/** The softbox rig as a plain scene: the three Lightformer rects (Device's lit set). */
function buildSoftboxScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0, 0, 0);
  const rect = (intensity: number, position: [number, number, number], scale: number) => {
    const mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        color: new Color(intensity, intensity, intensity),
        side: DoubleSide,
      }),
    );
    mesh.position.set(...position);
    mesh.scale.setScalar(scale);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  rect(2, [0, 3, 4], 8);
  rect(1.2, [-4, 1, 2], 5);
  rect(1, [4, -1, 3], 5);
  return scene;
}

async function loadEquirect(url: string, exr: boolean): Promise<Texture> {
  return exr ? await new EXRLoader().loadAsync(url) : await new RGBELoader().loadAsync(url);
}

async function loadEnvironment(gl: WebGLRenderer, key: string): Promise<Texture | null> {
  const pmrem = new PMREMGenerator(gl);
  try {
    if (key === SOFTBOX_SOURCE) {
      return pmrem.fromScene(buildSoftboxScene(), 0, 0.1, 1000).texture;
    }
    // User project sources ("<projectId>|<rel>"): resolve to a loadable URL, throwing on a missing file so the preload barrier fails the run loudly rather than exporting without reflections.
    const split = key.indexOf("|");
    if (split >= 0) {
      const projectId = revisedSources.get(key)?.projectId ?? key.slice(0, split);
      const rel = revisedSources.get(key)?.rel ?? key.slice(split + 1);
      const url = resolveProjectHdrUrl(projectId, rel);
      const equirect = await loadEquirect(url, /\.exr$/i.test(rel));
      const texture = pmrem.fromEquirectangular(equirect).texture;
      equirect.dispose();
      return texture;
    }
    const url = BUNDLED_HDRI[key];
    if (!url) {
      console.warn(`[environments] unknown environment source "${key}" — no reflections`);
      return null;
    }
    const equirect = await loadEquirect(url, false);
    const texture = pmrem.fromEquirectangular(equirect).texture;
    equirect.dispose();
    return texture;
  } finally {
    pmrem.dispose();
  }
}

/** One scene's authored environment across the v9 layers: the resolved lighting env (scene doc -> project -> the theme's own lighting block) wins over the v8 `theme.environment`. Returns undefined when nothing declares one (the shared-snapshot fallback at the seam). */
export function resolveSceneEnvironment(
  sceneTheme: Theme,
  projectLighting: LightingSpec | undefined,
  sceneDoc: SceneDoc | undefined,
): { source: string; intensity: number; rotationDeg: number } | undefined {
  return (
    sceneDoc?.lighting?.environment ??
    projectLighting?.environment ??
    sceneTheme.lighting?.environment ??
    sceneTheme.environment
  );
}

/** Every environment cache key a loaded project can reach: the project + scene themes' v8 blocks, and the v9 lighting layers (theme, project default, every scene doc). "none" needs no load and is excluded. */
export function collectEnvironmentSources(
  projectId: string | undefined,
  themes: readonly (Theme | undefined)[],
  projectLighting?: LightingSpec,
  sceneDocs?: readonly (SceneDoc | undefined)[],
): string[] {
  const keys = new Set<string>();
  const add = (source: string | undefined) => {
    if (source && source !== NONE_SOURCE) keys.add(environmentCacheKey(projectId, source));
  };
  for (const theme of themes) {
    add(theme?.environment?.source);
    add(theme?.lighting?.environment?.source);
  }
  add(projectLighting?.environment?.source);
  for (const doc of sceneDocs ?? []) add(doc?.lighting?.environment?.source);
  return [...keys];
}

// ── Env mirror (v9 · PR 4) ──────────────────────────────────────────
// A scene with any `envMirror` fixture replaces its environment with a one-shot PMREM `fromScene` bake: the resolved HDRI as an equirect-textured backdrop sphere plus a Lightformer-style emissive proxy per mirrored instance, so the fixture shows up as a crisp reflection on glossy surfaces. Baked once under the preload barrier, cached by a content key, never re-rendered mid-run; editing a mirrored fixture mints a new key and re-bakes on settle. World-space fixtures only (camera/subject warn and skip); keyframed fixtures bake at their base pose.

interface MirrorProxy {
  position: [number, number, number];
  rotationDeg: [number, number, number];
  size: [number, number];
  /** Linear emissive colour, already scaled by `emissive` and the instance jitter. */
  color: [number, number, number];
}

export interface MirrorRequest {
  key: string;
  /** The underlying environment's cache key, or null when the scene resolves none/"none". */
  envKey: string | null;
  proxies: MirrorProxy[];
}

/** djb2 over the request content: the bake cache key. Deterministic, content-addressed. */
function mirrorKey(envKey: string | null, proxies: MirrorProxy[]): string {
  const payload = JSON.stringify([envKey, proxies]);
  let h = 5381;
  for (let i = 0; i < payload.length; i++) h = ((h * 33) ^ payload.charCodeAt(i)) >>> 0;
  return `mirror:${h.toString(16)}`;
}

function mirrorProxies(fixtures: readonly FixtureSpec[], colors: Theme["colors"]): MirrorProxy[] {
  const proxies: MirrorProxy[] = [];
  for (const fixture of fixtures) {
    if (fixture.enabled === false || fixture.envMirror !== true) continue;
    if ((fixture.space ?? "world") !== "world") {
      console.warn(
        `[environments] fixture "${fixture.id}": envMirror is world-space only — skipped`,
      );
      continue;
    }
    const base = new Color(resolveLightingColour(fixture, colors));
    for (const inst of fixtureWorldInstances(fixture)) {
      const c = base.clone().multiplyScalar(fixture.emissive * inst.emissiveScale);
      proxies.push({
        position: inst.position,
        rotationDeg: fixture.rotationDeg ?? [0, 0, 0],
        size: [fixture.size[0], fixture.form === "panel" ? fixture.size[1] : fixture.size[1] * 2],
        color: [c.r, c.g, c.b],
      });
    }
  }
  return proxies;
}

/** The scene's env-mirror bake request (and its cache key), or null when no enabled world fixture mirrors. The key doubles as the scene's `environmentSource`, so `buildSceneRenderStates` and the preload sites agree by construction. */
export function sceneMirrorRequest(
  projectId: string | undefined,
  sceneTheme: Theme,
  projectLighting: LightingSpec | undefined,
  sceneDoc: SceneDoc | undefined,
): MirrorRequest | null {
  const resolved = resolveLighting(sceneTheme.lighting, projectLighting, sceneDoc?.lighting);
  if (!resolved?.fixtures?.some((f) => f.envMirror === true && f.enabled !== false)) return null;
  const proxies = mirrorProxies(resolved.fixtures, sceneTheme.colors);
  if (proxies.length === 0) return null;
  const env = resolveSceneEnvironment(sceneTheme, projectLighting, sceneDoc);
  const envKey =
    env && env.source !== NONE_SOURCE ? environmentCacheKey(projectId, env.source) : null;
  return { key: mirrorKey(envKey, proxies), envKey, proxies };
}

/** Every scene's mirror request for a loaded project (deduped by key); the preload sites await these alongside the plain environments. */
export function collectMirrorRequests(
  projectId: string | undefined,
  sceneThemes: readonly Theme[],
  projectLighting?: LightingSpec,
  sceneDocs?: readonly (SceneDoc | undefined)[],
): MirrorRequest[] {
  const byKey = new Map<string, MirrorRequest>();
  sceneThemes.forEach((theme, i) => {
    const request = sceneMirrorRequest(projectId, theme, projectLighting, sceneDocs?.[i]);
    if (request) byKey.set(request.key, request);
  });
  return [...byKey.values()];
}

/** Raw equirects retained for bakes only (the plain path PMREMs then disposes; the bake scene needs the source texture as a backdrop sphere map). */
const equirects = new Map<string, Texture>();

async function loadEquirectForKey(key: string): Promise<Texture | null> {
  const cached = equirects.get(key);
  if (cached) return cached;
  let url: string;
  let exr = false;
  const split = key.indexOf("|");
  if (split >= 0) {
    const rel = revisedSources.get(key)?.rel ?? key.slice(split + 1);
    url = resolveProjectHdrUrl(revisedSources.get(key)?.projectId ?? key.slice(0, split), rel);
    exr = /\.exr$/i.test(rel);
  } else {
    if (key === SOFTBOX_SOURCE) return null;
    const bundled = BUNDLED_HDRI[key];
    if (!bundled) return null;
    url = bundled;
  }
  const texture = await loadEquirect(url, exr);
  equirects.set(key, texture);
  return texture;
}

async function bakeMirrorEnvironment(gl: WebGLRenderer, request: MirrorRequest): Promise<Texture> {
  const scene = new Scene();
  scene.background = new Color(0, 0, 0);
  const disposables: { dispose(): void }[] = [];
  if (request.envKey) {
    const equirect = await loadEquirectForKey(request.envKey);
    if (equirect) {
      // SphereGeometry UVs are equirectangular, so a back-side textured sphere reproduces the HDRI surround for the bake camera at the origin region.
      const sky = new Mesh(
        new SphereGeometry(50, 64, 32),
        new MeshBasicMaterial({ map: equirect, side: BackSide }),
      );
      sky.scale.x = -1;
      scene.add(sky);
      disposables.push(sky.geometry, sky.material);
    }
  }
  for (const proxy of request.proxies) {
    const mesh = new Mesh(
      new PlaneGeometry(proxy.size[0], proxy.size[1]),
      new MeshBasicMaterial({
        color: new Color(proxy.color[0], proxy.color[1], proxy.color[2]),
        side: DoubleSide,
      }),
    );
    mesh.position.set(...proxy.position);
    mesh.rotation.set(
      (proxy.rotationDeg[0] * Math.PI) / 180,
      (proxy.rotationDeg[1] * Math.PI) / 180,
      (proxy.rotationDeg[2] * Math.PI) / 180,
    );
    scene.add(mesh);
    disposables.push(mesh.geometry, mesh.material);
  }
  const pmrem = new PMREMGenerator(gl);
  try {
    return pmrem.fromScene(scene, 0, 0.1, 1000).texture;
  } finally {
    pmrem.dispose();
    for (const d of disposables) d.dispose();
  }
}

/** Bake every mirror request not already cached (idempotent; shares the loaded/inflight maps with the plain sources, so `getLoadedEnvironment(key)` serves bakes at the seam identically). */
export async function preloadMirrorEnvironments(
  gl: WebGLRenderer,
  requests: readonly MirrorRequest[],
): Promise<void> {
  await Promise.all(
    requests.map((request) => {
      if (loaded.has(request.key)) return Promise.resolve(loaded.get(request.key) ?? null);
      let promise = inflight.get(request.key);
      if (!promise) {
        promise = bakeMirrorEnvironment(gl, request).then(
          (tex) => {
            loaded.set(request.key, tex);
            inflight.delete(request.key);
            return tex as Texture | null;
          },
          (e) => {
            inflight.delete(request.key);
            throw e;
          },
        );
        inflight.set(request.key, promise);
      }
      return promise;
    }),
  );
}

/** Resolves every collected cache key (idempotent; concurrent calls share in-flight loads); the export preamble awaits this (a missing user file rejects and fails the run), the preview fire-and-forgets it with a catch and invalidates on completion. */
export async function preloadEnvironments(
  gl: WebGLRenderer,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(
    keys.map((key) => {
      if (loaded.has(key)) return Promise.resolve(loaded.get(key) ?? null);
      let promise = inflight.get(key);
      if (!promise) {
        promise = loadEnvironment(gl, key).then(
          (tex) => {
            loaded.set(key, tex);
            inflight.delete(key);
            return tex;
          },
          (e) => {
            // Bundled sources degrade (warn + no reflections); user sources re-throw so the export preamble fails loudly.
            inflight.delete(key);
            if (key.includes("|")) throw e;
            console.warn(`[environments] loading "${key}" failed:`, e);
            loaded.set(key, null);
            return null;
          },
        );
        inflight.set(key, promise);
      }
      return promise;
    }),
  );
}
