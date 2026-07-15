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
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import ferndaleUrl from "../assets/hdri/ferndale-studio.hdr?url";
import monochromeUrl from "../assets/hdri/monochrome-studio.hdr?url";
import storyUrl from "../assets/hdri/story-studio.hdr?url";
import type { Theme } from "../theme/tokens";

/** Theme environments: PMREM textures for `theme.environment.source`, cached by source id for the app's lifetime. Two source kinds today: bundled CC0 studio HDRIs (`kookaburra:<name>.hdr`, converted by `pnpm assets:hdri`) and the procedural `kookaburra:softbox` preset (the Device/DeviceMockup Lightformer look, rebuilt as a plain three scene and PMREM'd once). Determinism: RGBE decode is pure CPU and PMREM is fixed-function GPU work (the MSAA precedent), so it's same-machine deterministic; `preloadEnvironments` is an export-preamble barrier so every themed frame finds its texture already resolved, while the preview calls it too and simply invalidates when textures land (a reflection-less first paint is preview-only). */

const BUNDLED_HDRI: Record<string, string> = {
  "kookaburra:ferndale-studio": ferndaleUrl,
  "kookaburra:monochrome-studio": monochromeUrl,
  "kookaburra:story-studio": storyUrl,
};

export const SOFTBOX_SOURCE = "kookaburra:softbox";

/** Resolved textures by source id; `null` marks a source that failed/isn't wired (warned once). */
const loaded = new Map<string, Texture | null>();
const inflight = new Map<string, Promise<Texture | null>>();

/** The PMREM texture for a source, or null while loading / for unknown sources. Sync, called per render target at the compositor seam. */
export function getLoadedEnvironment(source: string): Texture | null {
  return loaded.get(source) ?? null;
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

async function loadEnvironment(gl: WebGLRenderer, source: string): Promise<Texture | null> {
  const pmrem = new PMREMGenerator(gl);
  try {
    if (source === SOFTBOX_SOURCE) {
      return pmrem.fromScene(buildSoftboxScene(), 0, 0.1, 1000).texture;
    }
    const url = BUNDLED_HDRI[source];
    if (!url) {
      console.warn(`[environments] unknown environment source "${source}" — no reflections`);
      return null;
    }
    const equirect = await new RGBELoader().loadAsync(url);
    const texture = pmrem.fromEquirectangular(equirect).texture;
    equirect.dispose();
    return texture;
  } catch (e) {
    console.warn(`[environments] loading "${source}" failed:`, e);
    return null;
  } finally {
    pmrem.dispose();
  }
}

/** Resolves every environment source the given themes reference (idempotent; concurrent calls share in-flight loads); the export preamble awaits this, the preview fire-and-forgets it and invalidates on completion. */
export async function preloadEnvironments(
  gl: WebGLRenderer,
  themes: readonly (Theme | undefined)[],
): Promise<void> {
  const sources = new Set<string>();
  for (const theme of themes) {
    if (theme?.environment) sources.add(theme.environment.source);
  }
  await Promise.all(
    [...sources].map((source) => {
      if (loaded.has(source)) return Promise.resolve(loaded.get(source) ?? null);
      let promise = inflight.get(source);
      if (!promise) {
        promise = loadEnvironment(gl, source).then((tex) => {
          loaded.set(source, tex);
          inflight.delete(source);
          return tex;
        });
        inflight.set(source, promise);
      }
      return promise;
    }),
  );
}
