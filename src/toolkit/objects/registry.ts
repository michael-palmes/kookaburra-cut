import { invoke } from "@tauri-apps/api/core";
import { type ObjectManifest, parseObjectManifest } from "./schema";

/** Object resolution (the theme/registry.ts pattern): bundled objects ship as JSON + glb beside this module; user objects live at `~/Kookaburra Cut/objects/<slug>/object.json` and resolve via the native `read_object` command under `ws:<slug>` ids. Unknown or broken ids degrade to `undefined` (the consumer renders nothing); a reference can degrade but never crash a project load. */

// Explicit imports (not a glob) keep the bundled set type-checked and vitest-loadable; the first bundled object must register here AND in schema.test.ts (a silently-degraded builtin must fail unit tests, not gates). Empty until objects ship.
const BUILTIN_DOCS: { doc: unknown; source: string }[] = [];

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
}

/** Every object visible to pickers: bundled first, then the workspace library (re-stamped `ws:<slug>` from the folder, like themes); listing failures degrade to bundled-only. */
export async function listObjects(): Promise<ObjectManifest[]> {
  const out = Object.values(builtinObjects);
  try {
    const listings = await invoke<ObjectListing[]>("list_objects");
    for (const { slug, json } of listings) {
      const manifest = parseObjectManifest(JSON.parse(json), `ws:${slug}`);
      // The folder slug is the identity; the document's own id cannot collide with another object's.
      if (manifest) out.push({ ...manifest, id: `${WORKSPACE_OBJECT_PREFIX}${slug}` });
    }
  } catch (e) {
    console.warn("[objects] workspace listing failed:", e);
  }
  return out;
}

/** Resolves an object id from either source; async because workspace objects read through the native side. Never rejects: unknown/broken ids return `undefined` and the consumer degrades. */
export async function resolveObject(id: string | undefined): Promise<ObjectManifest | undefined> {
  if (!id) return undefined;
  if (isWorkspaceObjectId(id)) {
    const slug = id.slice(WORKSPACE_OBJECT_PREFIX.length);
    try {
      const text = await invoke<string>("read_object", { slug });
      const manifest = parseObjectManifest(JSON.parse(text), id);
      if (manifest) return { ...manifest, id };
    } catch (e) {
      console.warn(`[objects] workspace object "${id}" failed to load:`, e);
    }
    return undefined;
  }
  const manifest = builtinObjects[id];
  if (!manifest) console.warn(`[objects] unknown object id "${id}" — nothing rendered`);
  return manifest;
}
