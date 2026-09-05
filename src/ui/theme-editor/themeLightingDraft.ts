import type { FixtureSpec, LightSpec } from "../../theme/tokens";
import { getIn, isRecord, setIn, type ThemeDoc } from "./themeDraft";

export type LightingEntityKind = "lights" | "fixtures";

function entries(doc: ThemeDoc, kind: LightingEntityKind): unknown[] {
  const raw = getIn(doc, ["lighting", kind]);
  return Array.isArray(raw) ? raw : [];
}

function preserveFields(raw: unknown, parsed: unknown): unknown {
  if (!isRecord(raw) || !isRecord(parsed)) return structuredClone(parsed);
  const next = structuredClone(raw);
  for (const [key, value] of Object.entries(parsed)) next[key] = preserveFields(raw[key], value);
  return next;
}

export function patchThemeLightingEntity<T extends LightSpec | FixtureSpec>(
  doc: ThemeDoc,
  kind: LightingEntityKind,
  entity: T,
  mutate: (next: T) => void,
): ThemeDoc {
  const list = entries(doc, kind);
  const index = list.findIndex((entry) => isRecord(entry) && entry.id === entity.id);
  if (index < 0) return doc;
  const next = preserveFields(list[index], entity) as T;
  mutate(next);
  return setIn(
    doc,
    ["lighting", kind],
    list.map((entry, i) => (i === index ? next : entry)),
  );
}

export function appendThemeLightingEntity(
  doc: ThemeDoc,
  kind: LightingEntityKind,
  entity: LightSpec | FixtureSpec,
): ThemeDoc {
  return setIn(doc, ["lighting", kind], [...entries(doc, kind), entity]);
}

export function removeThemeLightingEntity(
  doc: ThemeDoc,
  kind: LightingEntityKind,
  id: string,
): ThemeDoc {
  const next = entries(doc, kind).filter((entry) => !isRecord(entry) || entry.id !== id);
  return setIn(doc, ["lighting", kind], next.length ? next : undefined);
}

export function nextThemeLightingId(doc: ThemeDoc, kind: LightingEntityKind): string {
  const ids = new Set(
    entries(doc, kind)
      .filter(isRecord)
      .map((entry) => entry.id),
  );
  const prefix = kind === "lights" ? "light" : "fixture";
  for (let index = 1; ; index += 1) {
    const id = `${prefix}-${index}`;
    if (!ids.has(id)) return id;
  }
}

export function duplicateThemeLightingEntity(
  doc: ThemeDoc,
  kind: LightingEntityKind,
  id: string,
): ThemeDoc {
  const source = entries(doc, kind).find((entry) => isRecord(entry) && entry.id === id);
  if (!isRecord(source)) return doc;
  const copy = { ...structuredClone(source), id: nextThemeLightingId(doc, kind) };
  return setIn(doc, ["lighting", kind], [...entries(doc, kind), copy]);
}

export function changeThemeLightType(light: LightSpec, type: LightSpec["type"]): void {
  const next = light as unknown as ThemeDoc;
  next.type = type;
  if (type === "spot") {
    next.angleDeg ??= 45;
    next.penumbra ??= 0.4;
  } else {
    delete next.angleDeg;
    delete next.penumbra;
  }
  if (type === "area") {
    next.width ??= 2;
    next.height ??= 2;
  } else {
    delete next.width;
    delete next.height;
  }
  if (type !== "point" && type !== "spot") {
    delete next.distance;
    delete next.decay;
  }
  if (type === "point" || type === "area") delete next.castShadow;
}
