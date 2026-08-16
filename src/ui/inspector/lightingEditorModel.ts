import { FPS } from "../../engine/format";
import { nextKeyId } from "../../engine/keyedTrack";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { chainLightingSegments } from "../../engine/sceneLighting";
import type {
  LightingKey,
  LightingPose,
  LightingSegment,
  LightingSpec,
  ThemeShadowSpec,
} from "../../theme/tokens";

const FRAME_MS = 1000 / FPS;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Comparison B inherits the scene lighting until it owns an override. Present that exact scene layer to the shared editor. */
export function comparisonLightingEditorDoc(doc: SceneDoc): SceneDoc {
  return {
    ...doc,
    lighting: doc.compare?.b?.lighting ?? doc.lighting,
  };
}

/** Run a shared Lighting-editor mutation against comparison B, materialising inherited scene lighting on the first successful write. */
export function mutateComparisonLightingTarget<T>(
  doc: SceneDoc,
  mutate: (editorDoc: SceneDoc) => T,
): T {
  const sceneLighting = doc.lighting;
  doc.lighting = structuredClone(doc.compare?.b?.lighting ?? sceneLighting);
  let result: T;
  let written: SceneDoc["lighting"];
  try {
    result = mutate(doc);
    written = doc.lighting;
  } finally {
    doc.lighting = sceneLighting;
  }
  if (result === false) return result;
  if (!doc.compare) doc.compare = {};
  if (!doc.compare.b) doc.compare.b = {};
  doc.compare.b.lighting = written;
  return result;
}

export function lightingLookChangeCount(
  current: LightingSpec | undefined,
  look: LightingSpec | undefined,
): number {
  if (!current || !look) return 0;
  const currentShadow = current.shadow;
  const lookShadow = look.shadow;
  const fields: [unknown, unknown][] = [
    [current.environment?.source, look.environment?.source],
    [current.environment?.intensity, look.environment?.intensity],
    [current.environment?.rotationDeg, look.environment?.rotationDeg],
    [current.sun?.enabled ?? true, look.sun?.enabled ?? true],
    [current.sun?.azimuthDeg, look.sun?.azimuthDeg],
    [current.sun?.elevationDeg, look.sun?.elevationDeg],
    [current.sun?.intensity, look.sun?.intensity],
    [current.sun?.kelvin, look.sun?.kelvin],
    [current.sun?.angularDeg, look.sun?.angularDeg],
    [current.sun?.castShadow ?? true, look.sun?.castShadow ?? true],
    [current.sun?.color, look.sun?.color],
    [current.sun?.colorToken, look.sun?.colorToken],
    [current.ambient, look.ambient],
    [current.ambientColor ?? "#ffffff", look.ambientColor ?? "#ffffff"],
    [current.fills ?? [], look.fills ?? []],
    [current.lights ?? [], look.lights ?? []],
    [current.fixtures ?? [], look.fixtures ?? []],
    [currentShadow?.technique, lookShadow?.technique],
    [currentShadow?.enabled ?? true, lookShadow?.enabled ?? true],
    [currentShadow?.catchBackdrop ?? true, lookShadow?.catchBackdrop ?? true],
    [currentShadow?.softness, lookShadow?.softness],
    [currentShadow?.opacity, lookShadow?.opacity],
    [currentShadow?.mapSize, lookShadow?.mapSize],
    [currentShadow?.bias, lookShadow?.bias],
    [currentShadow?.color ?? "#000000", lookShadow?.color ?? "#000000"],
  ];
  return fields.reduce((count, [a, b]) => count + (same(a, b) ? 0 : 1), 0);
}

function compatiblePose(pose: LightingPose, look: LightingSpec): LightingPose {
  const next: LightingPose = {};
  if (look.ambient !== undefined && pose.ambient !== undefined) next.ambient = pose.ambient;
  if (look.environment && pose.environmentIntensity !== undefined) {
    next.environmentIntensity = pose.environmentIntensity;
  }
  if (look.environment && pose.environmentRotationDeg !== undefined) {
    next.environmentRotationDeg = pose.environmentRotationDeg;
  }
  if (look.sun && pose.sun) next.sun = structuredClone(pose.sun);

  const lightIds = new Set((look.lights ?? []).map((light) => light.id));
  for (const [id, entry] of Object.entries(pose.lights ?? {})) {
    if (!lightIds.has(id)) continue;
    next.lights = { ...(next.lights ?? {}), [id]: structuredClone(entry) };
  }
  const fixtureIds = new Set((look.fixtures ?? []).map((fixture) => fixture.id));
  for (const [id, entry] of Object.entries(pose.fixtures ?? {})) {
    if (!fixtureIds.has(id)) continue;
    next.fixtures = { ...(next.fixtures ?? {}), [id]: structuredClone(entry) };
  }
  return next;
}

export function applyLightingLook(
  current: LightingSpec | undefined,
  look: LightingSpec,
  presetId: string,
  compatibleRig: LightingSpec = look,
): LightingSpec {
  const next: LightingSpec = structuredClone({ ...look, preset: presetId });
  if (current?.animationEnabled !== undefined) next.animationEnabled = current.animationEnabled;
  if (current?.keys?.length) {
    next.keys = current.keys.map((key) => ({
      ...key,
      pose: compatiblePose(key.pose, compatibleRig),
    }));
    next.segments = chainLightingSegments(next.keys, current.segments);
  }
  return next;
}

export type LightingAnimationScope =
  | { kind: "rig" }
  | { kind: "light"; id: string }
  | { kind: "fixture"; id: string };

export function lightingPoseForScope(
  pose: LightingPose,
  scope: LightingAnimationScope,
): LightingPose {
  if (scope.kind === "rig") return structuredClone(pose);
  if (scope.kind === "light") {
    const entry = pose.lights?.[scope.id];
    return entry ? { lights: { [scope.id]: structuredClone(entry) } } : {};
  }
  const entry = pose.fixtures?.[scope.id];
  return entry ? { fixtures: { [scope.id]: structuredClone(entry) } } : {};
}

export interface KeyAtPlayheadResult {
  lighting: LightingSpec;
  keyId: string;
  created: boolean;
  tMs: number;
}

export function keyLightingAtPlayhead(
  lighting: LightingSpec | undefined,
  localMs: number,
  durationMs: number,
  pose: LightingPose,
): KeyAtPlayheadResult {
  const safeDurationMs = Math.max(0, durationMs);
  const frame = Math.min(
    Math.floor(safeDurationMs / FRAME_MS),
    Math.round(Math.min(safeDurationMs, Math.max(0, localMs)) / FRAME_MS),
  );
  const tMs = Math.round(frame * FRAME_MS);
  const current = structuredClone(lighting ?? {});
  const existing = current.keys?.find((key) => key.tMs === tMs);
  if (existing) return { lighting: current, keyId: existing.id, created: false, tMs };

  const keys = [...(current.keys ?? [])];
  const key: LightingKey = {
    id: nextKeyId({ keys, segments: current.segments ?? [] }),
    tMs,
    pose: structuredClone(pose),
  };
  keys.push(key);
  keys.sort((a, b) => a.tMs - b.tMs);
  current.keys = keys;
  current.segments = chainLightingSegments(keys, current.segments);
  return { lighting: current, keyId: key.id, created: true, tMs };
}

export function adjacentLightingKey(
  keys: readonly LightingKey[] | undefined,
  selectedId: string | null,
  direction: -1 | 1,
): LightingKey | null {
  if (!keys?.length) return null;
  const sorted = [...keys].sort((a, b) => a.tMs - b.tMs);
  const index = selectedId ? sorted.findIndex((key) => key.id === selectedId) : -1;
  if (index < 0) return direction < 0 ? sorted[sorted.length - 1] : sorted[0];
  return sorted[Math.min(sorted.length - 1, Math.max(0, index + direction))] ?? null;
}

export function setIncomingLightingEase(
  lighting: LightingSpec,
  selectedKeyId: string,
  ease: string,
): LightingSpec {
  if (!lighting.keys?.some((key) => key.id === selectedKeyId)) return structuredClone(lighting);
  const next = structuredClone(lighting);
  const segments: LightingSegment[] = chainLightingSegments(next.keys ?? [], next.segments);
  const incoming = segments.find((segment) => segment.to === selectedKeyId);
  if (incoming) incoming.ease = ease;
  next.segments = segments;
  return next;
}

export type LightingShadowStyle = "none" | "soft-contact" | "cast";

export function lightingShadowStyle(shadow: ThemeShadowSpec | undefined): LightingShadowStyle {
  if (shadow?.technique === "none") return "none";
  if ((shadow?.opacity ?? 0.3) >= 0.4 || (shadow?.softness ?? 0.5) <= 0.4) return "cast";
  return "soft-contact";
}

export function applyLightingShadowStyle(
  shadow: ThemeShadowSpec | undefined,
  style: LightingShadowStyle,
): ThemeShadowSpec {
  const next: ThemeShadowSpec = structuredClone(
    shadow ?? {
      technique: "map",
      softness: 0.5,
      opacity: 0.3,
      mapSize: 2048,
      bias: -0.0005,
    },
  );
  if (style === "none") {
    next.technique = "none";
    return next;
  }
  next.technique = "map";
  if (style === "soft-contact") {
    next.softness = 0.75;
    next.opacity = 0.28;
  } else {
    next.softness = 0.3;
    next.opacity = 0.48;
  }
  return next;
}

export function updateLightingKeyPose(
  lighting: LightingSpec,
  keyId: string,
  mutate: (pose: LightingPose) => void,
): LightingSpec {
  const next = structuredClone(lighting);
  const key = next.keys?.find((candidate) => candidate.id === keyId);
  if (!key) return next;
  mutate(key.pose);
  return next;
}

export function duplicateLightingKey(
  lighting: LightingSpec,
  keyId: string,
  durationMs: number,
): { lighting: LightingSpec; keyId: string; created: boolean } {
  const next = structuredClone(lighting);
  const source = next.keys?.find((key) => key.id === keyId);
  if (!source) return { lighting: next, keyId, created: false };
  const occupied = new Set((next.keys ?? []).map((key) => key.tMs));
  let tMs = source.tMs + FRAME_MS;
  while (tMs <= durationMs && occupied.has(Math.round(tMs))) tMs += FRAME_MS;
  if (tMs > durationMs) {
    tMs = source.tMs - FRAME_MS;
    while (tMs >= 0 && occupied.has(Math.round(tMs))) tMs -= FRAME_MS;
  }
  if (tMs < 0 || tMs > durationMs) return { lighting: next, keyId, created: false };

  const copy: LightingKey = {
    ...structuredClone(source),
    id: nextKeyId({ keys: next.keys ?? [], segments: next.segments ?? [] }),
    tMs: Math.round(tMs),
  };
  next.keys = [...(next.keys ?? []), copy].sort((a, b) => a.tMs - b.tMs);
  next.segments = chainLightingSegments(next.keys, next.segments);
  return { lighting: next, keyId: copy.id, created: true };
}

export function deleteLightingKey(lighting: LightingSpec, keyId: string): LightingSpec {
  const next = structuredClone(lighting);
  const keys = (next.keys ?? []).filter((key) => key.id !== keyId);
  if (keys.length === 0) {
    delete next.keys;
    delete next.segments;
    return next;
  }
  next.keys = keys;
  next.segments = chainLightingSegments(keys, next.segments);
  return next;
}
