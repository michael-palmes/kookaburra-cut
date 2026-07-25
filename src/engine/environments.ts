import {
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
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
import type { LightingSpec, Theme } from "../theme/tokens";
import { resolveProjectHdrUrl } from "./project";
import type { SceneDoc } from "./sceneDocSchema";

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

/** The environments cache key for an authored source: bundled ids and "none" pass through; project-relative user paths key per project so two projects' "assets/studio.hdr" never collide. */
export function environmentCacheKey(projectId: string | undefined, source: string): string {
  if (source.startsWith("kookaburra:") || source === NONE_SOURCE) return source;
  return `${projectId ?? ""}|${source}`;
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
      const projectId = key.slice(0, split);
      const rel = key.slice(split + 1);
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
