/** Panel-fill textures for the overlay slide pass, cached at module level because the compositor reads them SYNCHRONOUSLY at the render seam (it cannot suspend). Gradients bake through the stage's `gradientTexture`, so a panel gradient and a background gradient are the same pixels; images load once per URL and settle before frame 0 through `preloadOverlayPanelImages` (the `preloadProjectImages` barrier pattern). In preview a not-yet-loaded image renders the panel's fallback colour for a frame and self-heals on the next; during export the barrier means that can never happen. See docs/overlays.md. */

import { type DataTexture, SRGBColorSpace, type Texture, TextureLoader } from "three";
import { assetVersionSuffix } from "../store/assetVersionStore";
import type { GradientSpec } from "../theme/tokens";
import { gradientTexture } from "../toolkit/stage/backdrops";
import { canvasHandle } from "./exportBridge";
import { isExporting } from "./exportState";
import { resolveAssetUrl } from "./project";

/** Baked gradient rasters, insertion-ordered as an LRU: each is 512² RGBA (1 MB), so the cap bounds a long editing session while covering both sides of a transition many times over. */
const GRADIENT_CACHE_MAX = 8;
const gradients = new Map<string, DataTexture>();

/** The panel's baked gradient for `key` (from `gradientCacheKey`), rasterised on first use. */
export function panelGradientTexture(key: string, spec: GradientSpec): DataTexture {
  const cached = gradients.get(key);
  if (cached) {
    gradients.delete(key);
    gradients.set(key, cached);
    return cached;
  }
  const texture = gradientTexture(spec);
  gradients.set(key, texture);
  while (gradients.size > GRADIENT_CACHE_MAX) {
    const oldest = gradients.keys().next().value;
    if (oldest === undefined) break;
    gradients.get(oldest)?.dispose();
    gradients.delete(oldest);
  }
  return texture;
}

const images = new Map<string, Texture>();
const loading = new Map<string, Promise<void>>();
const warned = new Set<string>();

/** The loadable URL for a panel image, matching `ImageCard`'s cache-bust suffix so a re-imported asset lands the URL the rest of the app requests. A missing asset degrades to the flat panel colour, warning once (the seam runs every frame) but never latching, so importing the file later heals it. */
function panelImageUrl(projectId: string, src: string): string | null {
  try {
    return resolveAssetUrl(projectId, src) + assetVersionSuffix(projectId, src);
  } catch (e) {
    const id = `${projectId}:${src}`;
    if (!warned.has(id)) {
      warned.add(id);
      console.warn(`[frame] panel image "${src}" unresolved:`, e);
    }
    return null;
  }
}

function loadPanelImage(url: string): Promise<void> {
  const pending = loading.get(url);
  if (pending) return pending;
  const load = new TextureLoader()
    .loadAsync(url)
    .then((texture) => {
      texture.colorSpace = SRGBColorSpace;
      images.set(url, texture);
      // Preview only: demand-mode repaint, so a freshly picked panel image lands without waiting for the next interaction. An export awaits the preamble barrier, so no load can resolve mid-run.
      if (!isExporting()) canvasHandle.current?.advance(performance.now());
    })
    .catch((e) => {
      console.warn(`[frame] panel image "${url}" failed to load:`, e);
    });
  loading.set(url, load);
  return load;
}

/** The panel's image texture, or null while it loads (or when the asset is missing); the caller falls back to the flat panel colour. */
export function panelImageTexture(projectId: string, src: string): Texture | null {
  const url = panelImageUrl(projectId, src);
  if (!url) return null;
  const cached = images.get(url);
  if (cached) return cached;
  void loadPanelImage(url);
  return null;
}

/** Export-preamble barrier: settle every panel image a scene frame references before frame 0. */
export async function preloadOverlayPanelImages(
  projectId: string,
  sources: readonly string[],
): Promise<void> {
  const urls = sources
    .map((src) => panelImageUrl(projectId, src))
    .filter((url): url is string => url !== null);
  if (urls.length === 0) return;
  await Promise.all(urls.map(loadPanelImage));
}
