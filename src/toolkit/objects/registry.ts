import { invoke } from "@tauri-apps/api/core";
import { fsUrl } from "../../engine/media";
import avocadoDoc from "./builtin/avocado.json";
import bitcoinCoinDoc from "./builtin/bitcoin-coin.json";
import boomboxDoc from "./builtin/boombox.json";
import waterBottleDoc from "./builtin/water-bottle.json";
import { BUILTIN_OBJECT_GLB_URLS } from "./builtinObjectGlbUrls";
import { type ObjectManifest, parseObjectManifest } from "./schema";

/** Object resolution (the theme/registry.ts pattern): bundled objects ship as JSON + glb beside this module; user objects live at `~/Kookaburra Cut/objects/<slug>/object.json` and resolve via the native `read_object` command under `ws:<slug>` ids. Unknown or broken ids degrade to `undefined` (the consumer renders nothing); a reference can degrade but never crash a project load. */

// Explicit imports (not a glob) keep the bundled set type-checked and vitest-loadable; a new bundled object must register here AND in schema.test.ts (a silently-degraded builtin must fail unit tests, not gates).
const BUILTIN_DOCS: { doc: unknown; source: string }[] = [
  { doc: bitcoinCoinDoc, source: "builtin/bitcoin-coin" },
  { doc: waterBottleDoc, source: "builtin/water-bottle" },
  { doc: avocadoDoc, source: "builtin/avocado" },
  { doc: boomboxDoc, source: "builtin/boombox" },
];

/** Committed picker thumbnails for bundled objects, baked by `--action object-previews`; a missing still degrades to a text card. */
const bundledThumbs = import.meta.glob<string>("../../assets/object-previews/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Bundled objects keyed by id. */
export const builtinObjects: Record<string, ObjectManifest> = {};
for (const { doc, source } of BUILTIN_DOCS) {
  const manifest = parseObjectManifest(doc, source);
  if (manifest) builtinObjects[manifest.id] = manifest;
}

export const WORKSPACE_OBJECT_PREFIX = "ws:";

export function isWorkspaceObjectId(id: string): boolean {
  return id.startsWith(WORKSPACE_OBJECT_PREFIX);
}

interface ObjectListing {
  slug: string;
  json: string;
  /** Absolute object folder (native owns paths); glb/thumbnail URLs build from it. */
  dir: string;
}

/** A picker/renderer-ready object: the manifest plus resolved asset URLs. */
export interface ResolvedObjectAsset {
  manifest: ObjectManifest;
  glbUrl: string;
  thumbnailUrl?: string;
}

function bundledAsset(manifest: ObjectManifest): ResolvedObjectAsset | undefined {
  const glbUrl = BUILTIN_OBJECT_GLB_URLS[manifest.glb];
  if (!glbUrl) {
    console.warn(`[objects] bundled object "${manifest.id}" names an unshipped glb — ignored`);
    return undefined;
  }
  const thumbnailUrl = manifest.thumbnail
    ? bundledThumbs[`../../assets/object-previews/${manifest.thumbnail}`]
    : undefined;
  return { manifest, glbUrl, ...(thumbnailUrl ? { thumbnailUrl } : {}) };
}

function workspaceAsset(manifest: ObjectManifest, dir: string): ResolvedObjectAsset {
  const thumb = manifest.thumbnail ? `${dir}/${manifest.thumbnail}` : undefined;
  return {
    manifest,
    glbUrl: fsUrl(`${dir}/${manifest.glb}`),
    ...(thumb ? { thumbnailUrl: fsUrl(thumb) } : {}),
  };
}

/** Every object visible to pickers, with asset URLs resolved: bundled first, then the workspace library (re-stamped `ws:<slug>` from the folder, like themes); listing failures degrade to bundled-only. */
export async function listObjects(): Promise<ResolvedObjectAsset[]> {
  const out: ResolvedObjectAsset[] = [];
  for (const manifest of Object.values(builtinObjects)) {
    const asset = bundledAsset(manifest);
    if (asset) out.push(asset);
  }
  try {
    const listings = await invoke<ObjectListing[]>("list_objects");
    for (const { slug, json, dir } of listings) {
      const manifest = parseObjectManifest(JSON.parse(json), `ws:${slug}`);
      // The folder slug is the identity; the document's own id cannot collide with another object's.
      if (manifest) {
        out.push(workspaceAsset({ ...manifest, id: `${WORKSPACE_OBJECT_PREFIX}${slug}` }, dir));
      }
    }
  } catch (e) {
    console.warn("[objects] workspace listing failed:", e);
  }
  return out;
}

/** Resolves an object id from either source; async because workspace objects read through the native side. Never rejects: unknown/broken ids return `undefined` and the consumer degrades. */
export async function resolveObjectAsset(
  id: string | undefined,
): Promise<ResolvedObjectAsset | undefined> {
  if (!id) return undefined;
  if (isWorkspaceObjectId(id)) {
    const slug = id.slice(WORKSPACE_OBJECT_PREFIX.length);
    try {
      const listing = await invoke<ObjectListing>("read_object", { slug });
      const manifest = parseObjectManifest(JSON.parse(listing.json), id);
      if (manifest) return workspaceAsset({ ...manifest, id }, listing.dir);
    } catch (e) {
      console.warn(`[objects] workspace object "${id}" failed to load:`, e);
    }
    return undefined;
  }
  const manifest = builtinObjects[id];
  if (!manifest) {
    console.warn(`[objects] unknown object id "${id}" — nothing rendered`);
    return undefined;
  }
  return bundledAsset(manifest);
}

/** Back-compat manifest lookup (the pre-asset-URL surface some callers keep using). */
export async function resolveObject(id: string | undefined): Promise<ObjectManifest | undefined> {
  return (await resolveObjectAsset(id))?.manifest;
}

/** Import a picked .glb into the workspace library (native-side copy); returns the new `ws:` id. */
export async function importObject(name: string, sourcePath: string): Promise<string> {
  const slug = await invoke<string>("import_object", { name, sourcePath });
  return `${WORKSPACE_OBJECT_PREFIX}${slug}`;
}

/** Persist an imported object's picker thumbnail (raw PNG body, the write_theme_preview shape). */
export async function writeObjectThumbnail(id: string, png: Blob): Promise<void> {
  const slug = id.startsWith(WORKSPACE_OBJECT_PREFIX)
    ? id.slice(WORKSPACE_OBJECT_PREFIX.length)
    : id;
  await invoke("write_object_thumbnail", new Uint8Array(await png.arrayBuffer()), {
    headers: { "x-kookaburra-slug": slug },
  });
}

const assetCache = new Map<string, ResolvedObjectAsset | undefined>();
const assetInflight = new Map<string, Promise<ResolvedObjectAsset | undefined>>();

/** Suspense read for render paths: warm-cache hits return synchronously (`preloadSceneObjects` pre-warms before export frame 0); cold reads throw the in-flight promise, so previews pop the object in when it lands. */
export function readObjectAsset(id: string): ResolvedObjectAsset | undefined {
  if (assetCache.has(id)) return assetCache.get(id);
  let inflight = assetInflight.get(id);
  if (!inflight) {
    inflight = resolveObjectAsset(id).then((asset) => {
      assetCache.set(id, asset);
      assetInflight.delete(id);
      return asset;
    });
    assetInflight.set(id, inflight);
  }
  throw inflight;
}

/** Await one id into the warm cache (the export barrier's unit). */
export async function warmObjectAsset(id: string): Promise<ResolvedObjectAsset | undefined> {
  if (assetCache.has(id)) return assetCache.get(id);
  try {
    readObjectAsset(id);
  } catch (p) {
    await p;
  }
  return assetCache.get(id);
}
