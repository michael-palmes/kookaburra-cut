import { invoke } from "@tauri-apps/api/core";
import { SRGBColorSpace, type Texture, TextureLoader } from "three";
import { fsUrl } from "../../engine/media";
import { isWorkspaceProjectId, resolveAssetPath, workspaceSlug } from "../../engine/project";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { type EmojiCluster, prepareEmojiText } from "./emojiText";

/**
 * The colour-emoji raster cache. Each unique cluster is drawn ONCE with the system
 * font (Apple Color Emoji via canvas 2D) and frozen as a PNG in the project's own
 * `assets/.emoji-cache/`; determinism comes from that write-once file, not from the
 * renderer, exactly like system-font pinning. Workspace projects persist to disk;
 * bundled projects keep a session-only in-memory cache (recorded non-goal).
 */

/** Raster cell size; doubles as the cache filename's generator-version suffix (bumped 256 → 320 when ink-centred blitting replaced advance-centred drawing). */
export const EMOJI_RASTER_SIZE = 320;
/** Font pixel size inside the raster; the cell headroom absorbs full-bleed glyph art (~1.23 em). */
const RASTER_FONT_PX = 200;

const loader = new TextureLoader();
const textures = new Map<string, Texture>();
/** Clusters the installed macOS cannot draw (alpha-empty raster), key → cluster; session-cached, badge-visible. */
const unrenderable = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/** The project whose cache directory receives new rasters; set by the preload barrier, null for bundled projects. */
let activeProjectId: string | null = null;

function bump(): void {
  version++;
  for (const cb of listeners) cb();
}

export function subscribeEmojiRasters(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emojiRasterVersion(): number {
  return version;
}

/** Sync cache read for the render path; null until `ensureEmojiRasters` resolves the key. */
export function getEmojiTexture(key: string): Texture | null {
  return textures.get(key) ?? null;
}

/** Clusters the system font could not draw (key → cluster), for the inspector badge. */
export function unrenderableEmojiClusters(): ReadonlyMap<string, string> {
  return unrenderable;
}

function configureTexture(tex: Texture): Texture {
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Draw one cluster with the system emoji font; null when the OS has no glyph for it. Ink is measured from pixels and blitted centred: advance-based centring mis-places some VS16 sequences (WebKit reported a near-zero advance for U+2611 U+FE0F, clipping the art at the cell edge). */
async function rasterizeCluster(cluster: string): Promise<Blob | null> {
  const scratchSize = RASTER_FONT_PX * 3;
  const scratch = document.createElement("canvas");
  scratch.width = scratchSize;
  scratch.height = scratchSize;
  const sctx = scratch.getContext("2d");
  if (!sctx) return null;
  sctx.font = `${RASTER_FONT_PX}px "Apple Color Emoji"`;
  sctx.textAlign = "left";
  sctx.textBaseline = "alphabetic";
  sctx.fillText(cluster, RASTER_FONT_PX, RASTER_FONT_PX * 2);
  const data = sctx.getImageData(0, 0, scratchSize, scratchSize).data;
  let x0 = scratchSize;
  let y0 = scratchSize;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < scratchSize; y++) {
    for (let x = 0; x < scratchSize; x++) {
      if (data[(y * scratchSize + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const inkW = x1 - x0 + 1;
  const inkH = y1 - y0 + 1;
  const canvas = document.createElement("canvas");
  canvas.width = EMOJI_RASTER_SIZE;
  canvas.height = EMOJI_RASTER_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Oversized ink (never at these constants) scales to fit; normal ink blits 1:1, pixel-centred.
  const scale = Math.min(1, EMOJI_RASTER_SIZE / inkW, EMOJI_RASTER_SIZE / inkH);
  const dw = Math.round(inkW * scale);
  const dh = Math.round(inkH * scale);
  ctx.drawImage(
    scratch,
    x0,
    y0,
    inkW,
    inkH,
    Math.round((EMOJI_RASTER_SIZE - dw) / 2),
    Math.round((EMOJI_RASTER_SIZE - dh) / 2),
    dw,
    dh,
  );
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

function cacheFile(key: string): string {
  return `assets/.emoji-cache/${key}@${EMOJI_RASTER_SIZE}.png`;
}

async function resolveKey(key: string, cluster: string): Promise<void> {
  const projectId = activeProjectId;
  // Disk first: the frozen bytes win over re-rasterisation, so OS emoji updates can never move pixels.
  if (projectId) {
    try {
      const tex = await loader.loadAsync(fsUrl(resolveAssetPath(projectId, cacheFile(key))));
      textures.set(key, configureTexture(tex));
      return;
    } catch {
      // No cached file yet; fall through to rasterise.
    }
  }
  const blob = await rasterizeCluster(cluster);
  if (!blob) {
    unrenderable.set(key, cluster);
    warnOnce(key, `[emoji] the system font cannot draw "${cluster}" (${key}); it will not render`);
    return;
  }
  if (projectId && isWorkspaceProjectId(projectId)) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      await invoke("write_emoji_raster", bytes, {
        headers: {
          "x-kookaburra-slug": workspaceSlug(projectId),
          "x-kookaburra-key": `${key}@${EMOJI_RASTER_SIZE}`,
        },
      });
    } catch (e) {
      warnOnce(key, `[emoji] could not persist raster for ${key}: ${e}`);
    }
  }
  // Texture decodes from the same PNG bytes the cache stores, so preview and later re-export agree.
  const url = URL.createObjectURL(blob);
  try {
    const tex = await loader.loadAsync(url);
    textures.set(key, configureTexture(tex));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Resolve every cluster to a texture (disk, else rasterise + persist); memoised per key. */
export async function ensureEmojiRasters(clusters: readonly EmojiCluster[]): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const { key, cluster } of clusters) {
    if (textures.has(key) || unrenderable.has(key)) continue;
    let job = inflight.get(key);
    if (!job) {
      job = resolveKey(key, cluster).finally(() => {
        inflight.delete(key);
        bump();
      });
      inflight.set(key, job);
    }
    pending.push(job);
  }
  if (pending.length > 0) await Promise.all(pending);
}

/** Per-frame export barrier: settle every raster requested this frame before readback. */
export async function awaitEmojiRastersIdle(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.all([...inflight.values()]);
  }
}

/** Preload barrier for project load and the export preamble: statically scan every sidecar's text through the same substitution the primitives run, then settle all rasters before frame 0. Also pins which project's cache directory receives new rasters this session. */
export async function preloadEmojiRasters(
  projectId: string,
  sceneDocs: readonly (SceneDoc | undefined)[],
): Promise<void> {
  activeProjectId = projectId;
  const byKey = new Map<string, EmojiCluster>();
  for (const doc of sceneDocs) {
    if (!doc?.text) continue;
    for (const value of Object.values(doc.text)) {
      for (const cluster of prepareEmojiText(value).clusters) {
        if (!byKey.has(cluster.key)) byKey.set(cluster.key, cluster);
      }
    }
  }
  if (byKey.size > 0) await ensureEmojiRasters([...byKey.values()]);
}
