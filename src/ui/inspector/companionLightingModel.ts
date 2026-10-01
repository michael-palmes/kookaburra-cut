import type { SceneDoc } from "../../engine/sceneDocSchema";
import { MAX_SCENE_LIGHTS } from "../../engine/sceneLighting";
import type {
  FixtureSpec,
  LightingCompanion,
  LightingCompanionFields,
  LightingKey,
  LightingSpec,
  LightSpec,
  ThemeBackground,
} from "../../theme/tokens";

/** The Matching lighting toggle: a 3D background preset's rig written into the scene lighting layer, with a `companion` record so turning it off removes only what it wrote and the user's edits always survive. */

export interface CompanionTarget {
  look: string;
  preset: string;
  lighting: LightingCompanionFields;
}

/** The layers under the scene layer; lists and fields inherit project first, then theme. */
export interface LightingBelow {
  theme?: LightingSpec;
  project?: LightingSpec;
}

type PresetsByLook = Readonly<
  Record<string, readonly { id: string; lighting?: LightingCompanionFields }[]>
>;

const SCALAR_FIELDS = ["environment", "sun", "ambient", "ambientColor", "shadow"] as const;

/** Deep equality that ignores key order and undefined keys (a reload re-parses both sides in parser order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => same(value, b[i]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
}

function inherited<K extends keyof LightingSpec>(below: LightingBelow, field: K): LightingSpec[K] {
  return below.project?.[field] ?? below.theme?.[field];
}

function uniqueId(id: string, taken: readonly { id: string }[]): string {
  const ids = new Set(taken.map((entry) => entry.id));
  if (!ids.has(id)) return id;
  let n = 2;
  while (ids.has(`${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}

function keyedIds(keys: readonly LightingKey[] | undefined, field: "lights" | "fixtures") {
  const ids = new Set<string>();
  for (const key of keys ?? []) for (const id of Object.keys(key?.pose?.[field] ?? {})) ids.add(id);
  return ids;
}

function setField<T extends object, K extends keyof T>(target: T, field: K, value: T[K]): void {
  target[field] = value;
}

/** The block the side's background asks for: a scene3d pick whose applied preset carries lighting. */
export function companionTargetFor(
  background: ThemeBackground | undefined,
  presets: PresetsByLook,
): CompanionTarget | null {
  if (background?.type !== "scene3d" || !background.preset) return null;
  const lighting = presets[background.look]?.find((p) => p.id === background.preset)?.lighting;
  return lighting ? { look: background.look, preset: background.preset, lighting } : null;
}

/** The toggle's checked state: this layer holds the target's own write. */
export function companionMatches(
  lighting: LightingSpec | undefined,
  target: CompanionTarget | null,
): boolean {
  const record = lighting?.companion;
  return !!record && !!target && record.look === target.look && record.preset === target.preset;
}

/** Lights the block could not add because the scene was at the 16-light budget. */
export function companionSkippedLights(
  lighting: LightingSpec | undefined,
  target: CompanionTarget | null,
): number {
  if (!target || !companionMatches(lighting, target)) return 0;
  const wanted = target.lighting.lights?.length ?? 0;
  return Math.max(0, wanted - (lighting?.companion?.wrote.lights?.length ?? 0));
}

/** Toggle off: restore each field the toggle wrote that still holds its written value; edited fields, edited or keyed entries stay as the user's. */
export function removeCompanionLighting(
  scene: LightingSpec | undefined,
  below: LightingBelow,
): LightingSpec | undefined {
  const record = scene?.companion;
  if (!scene || !record) return scene;
  const next = structuredClone(scene);
  delete next.companion;
  for (const field of SCALAR_FIELDS) {
    if (record.wrote[field] === undefined || !same(next[field], record.wrote[field])) continue;
    if (record.prior[field] === undefined) delete next[field];
    else setField(next, field, structuredClone(record.prior[field]));
  }
  // A list left exactly as inherited hands back to the layers below.
  const lights = withoutAdded(next.lights, record.wrote.lights, keyedIds(next.keys, "lights"));
  if (lights) {
    if (same(lights, inherited(below, "lights") ?? [])) delete next.lights;
    else next.lights = lights;
  }
  const fixtures = withoutAdded(
    next.fixtures,
    record.wrote.fixtures,
    keyedIds(next.keys, "fixtures"),
  );
  if (fixtures) {
    if (same(fixtures, inherited(below, "fixtures") ?? [])) delete next.fixtures;
    else next.fixtures = fixtures;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The list minus the toggle's unedited, unkeyed entries; undefined when nothing was removed. */
function withoutAdded<T extends LightSpec | FixtureSpec>(
  current: readonly T[] | undefined,
  added: readonly T[] | undefined,
  keyed: ReadonlySet<string>,
): T[] | undefined {
  if (!current || !added?.length) return undefined;
  const byId = new Map(added.map((entry) => [entry.id, entry]));
  const remaining = current.filter((entry) => {
    const written = byId.get(entry.id);
    return !written || keyed.has(entry.id) || !same(entry, written);
  });
  return remaining.length < current.length ? remaining : undefined;
}

/** Toggle on: write the target's fields over the scene layer (stashing what they replace) and append its lights and fixtures to the resolved lists, inside the light budget. */
export function applyCompanionLighting(
  scene: LightingSpec | undefined,
  below: LightingBelow,
  target: CompanionTarget,
): LightingSpec {
  const next: LightingSpec = structuredClone(removeCompanionLighting(scene, below) ?? {});
  const wrote: LightingCompanionFields = {};
  const prior: LightingCompanion["prior"] = {};
  for (const field of SCALAR_FIELDS) {
    const value = target.lighting[field];
    if (value === undefined) continue;
    if (next[field] !== undefined) setField(prior, field, structuredClone(next[field]));
    setField(next, field, structuredClone(value));
    setField(wrote, field, structuredClone(value));
  }

  if (target.lighting.lights?.length) {
    const sun = next.sun ?? inherited(below, "sun");
    const slots = MAX_SCENE_LIGHTS - (sun && sun.enabled !== false ? 1 : 0);
    const lights = structuredClone(next.lights ?? inherited(below, "lights") ?? []);
    let enabled = lights.filter((light) => light.enabled !== false).length;
    const added: LightSpec[] = [];
    for (const light of target.lighting.lights) {
      const on = light.enabled !== false;
      if (lights.length >= MAX_SCENE_LIGHTS || (on && enabled >= slots)) continue;
      const entry = { ...structuredClone(light), id: uniqueId(light.id, lights) };
      lights.push(entry);
      added.push(entry);
      if (on) enabled += 1;
    }
    if (added.length > 0) {
      next.lights = lights;
      wrote.lights = structuredClone(added);
    }
  }

  if (target.lighting.fixtures?.length) {
    const fixtures = structuredClone(next.fixtures ?? inherited(below, "fixtures") ?? []);
    const added = target.lighting.fixtures.map((fixture) => {
      const entry = { ...structuredClone(fixture), id: uniqueId(fixture.id, fixtures) };
      fixtures.push(entry);
      return entry;
    });
    next.fixtures = fixtures;
    wrote.fixtures = structuredClone(added);
  }

  next.companion = { look: target.look, preset: target.preset, wrote, prior };
  return next;
}

/** After a background edit: an active toggle follows the new look or preset's block, or turns off when it has none. An off toggle stays off. */
export function reconcileCompanionLighting(
  scene: LightingSpec | undefined,
  below: LightingBelow,
  target: CompanionTarget | null,
): LightingSpec | undefined {
  if (!scene?.companion || companionMatches(scene, target)) return scene;
  return target
    ? applyCompanionLighting(scene, below, target)
    : removeCompanionLighting(scene, below);
}

/** Rewrite one comparison side's scene lighting layer. After materialises from Before on its first change and inherits again once it matches Before. */
export function writeSideLighting(
  doc: SceneDoc,
  side: "a" | "b",
  write: (lighting: LightingSpec | undefined) => LightingSpec | undefined,
): void {
  if (side === "a") {
    const next = write(doc.lighting);
    if (same(next, doc.lighting)) return;
    if (next === undefined) delete doc.lighting;
    else doc.lighting = next;
    return;
  }
  const current = doc.compare?.b?.lighting ?? doc.lighting;
  const next = write(current);
  if (same(next, current)) return;
  if (same(next, doc.lighting)) {
    if (doc.compare?.b) delete doc.compare.b.lighting;
    return;
  }
  doc.compare ??= {};
  doc.compare.b ??= {};
  doc.compare.b.lighting = next;
}
