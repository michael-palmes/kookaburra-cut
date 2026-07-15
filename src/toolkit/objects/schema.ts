/** The 3D-object manifest schema (`object.json` beside its glb): pure types + validation (the theme/schema.ts discipline — degrade with a warning, never throw), IO lives in registry.ts. Hard requirements for any object glb, enforced by convention not code: no Draco/KTX2 compression (CDN decoders break offline deterministic export; `gltf-transform optimize --compress false`, webp textures <= 2048), metres scale, +Z front, and every object used by a project needs the double preload barrier (`useGLTF.preload` + an awaited `GLTFLoader.loadAsync`) before export — see the kookaburra-scene-authoring skill. */

export const OBJECT_MANIFEST_VERSION = 1;

export interface ObjectLicence {
  /** Licence name, e.g. "CC0", "Royalty-free (purchased)". */
  name: string;
  holder?: string;
  url?: string;
  /** False = the binary must stay out of the repo (the licensed phone-glb precedent). */
  redistributable?: boolean;
}

export interface ObjectManifest {
  version: number;
  /** Stable id; workspace objects are re-stamped `ws:<slug>` from their folder on read. */
  id: string;
  name: string;
  /** The glb path relative to the object's folder (workspace) or the bundled asset key. */
  glb: string;
  /** Optional picker thumbnail beside the manifest. */
  thumbnail?: string;
  /** World-unit height the primitive auto-fits the model to (the Device TARGET_WORLD_HEIGHT pattern); absent = the consumer's default. */
  fitHeight?: number;
  licence?: ObjectLicence;
  tags?: string[];
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Validates a raw manifest, returning `undefined` (with a console warning) rather than throwing; unknown extra fields are dropped, structurally wrong optional fields are dropped, wrong required fields reject the whole doc. */
export function parseObjectManifest(raw: unknown, source: string): ObjectManifest | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[objects] ${source}: not an object — ignored`);
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.version !== "number" || doc.version < 1) {
    console.warn(`[objects] ${source}: missing/invalid "version" — ignored`);
    return undefined;
  }
  if (doc.version > OBJECT_MANIFEST_VERSION) {
    console.warn(`[objects] ${source}: version ${doc.version} is newer than this build — ignored`);
    return undefined;
  }
  if (!isStr(doc.id) || !isStr(doc.name) || !isStr(doc.glb)) {
    console.warn(`[objects] ${source}: needs string "id", "name" and "glb" — ignored`);
    return undefined;
  }
  const out: ObjectManifest = { version: doc.version, id: doc.id, name: doc.name, glb: doc.glb };
  if (isStr(doc.thumbnail)) out.thumbnail = doc.thumbnail;
  if (typeof doc.fitHeight === "number" && doc.fitHeight > 0) out.fitHeight = doc.fitHeight;
  if (typeof doc.licence === "object" && doc.licence !== null && !Array.isArray(doc.licence)) {
    const licence = doc.licence as Record<string, unknown>;
    if (isStr(licence.name)) {
      const parsed: ObjectLicence = { name: licence.name };
      if (isStr(licence.holder)) parsed.holder = licence.holder;
      if (isStr(licence.url)) parsed.url = licence.url;
      if (typeof licence.redistributable === "boolean") {
        parsed.redistributable = licence.redistributable;
      }
      out.licence = parsed;
    } else {
      console.warn(`[objects] ${source}: licence needs a string "name" — dropped`);
    }
  }
  if (Array.isArray(doc.tags)) {
    const tags = (doc.tags as unknown[]).filter(isStr);
    if (tags.length > 0) out.tags = tags;
  }
  return out;
}
