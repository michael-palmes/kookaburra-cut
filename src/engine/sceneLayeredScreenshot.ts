/** Layered-screenshot engine core: deep validation of the sidecar block (degrade-don't-crash, the sceneCamera pattern; the attach graph must be rooted and acyclic), pose sampling for the LS animation track, and rest-pose resolution honouring `animatedTrack`. Pure (no three.js, no clock reads) so preview and export agree by construction. */

import { ease, isEaseName } from "./ease";
import { lerp } from "./keyframes";
import type {
  LayeredScreenshotAttach,
  LayeredScreenshotItem,
  LayeredScreenshotKey,
  LayeredScreenshotLayer,
  LayeredScreenshotPose,
  SceneDoc,
} from "./sceneDocSchema";
import { validLayeredScreenshotPose } from "./sceneDocSchema";

/** A normalized animation segment: key ids resolved to the shared key objects. */
export interface LayeredScreenshotTrackSegment {
  from: LayeredScreenshotKey;
  to: LayeredScreenshotKey;
  /** An engine/ease.ts name (`ease()` degrades unknown names at sample time). */
  ease: string;
}

/** A validated, sorted LS animation track (keys ascending; segments ordered, non-overlapping). */
export interface LayeredScreenshotTrack {
  keys: LayeredScreenshotKey[];
  segments: LayeredScreenshotTrackSegment[];
}

/** A validated composition: layers whose attach graphs are rooted and acyclic, plus the optional normalized track. */
export interface NormalizedLayeredScreenshot {
  layers: LayeredScreenshotLayer[];
  pose: LayeredScreenshotPose;
  track: LayeredScreenshotTrack | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The builder's seed and the schema's fallback: flat, front-on, auto-fit. */
export function defaultLayeredScreenshotPose(): LayeredScreenshotPose {
  return { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] };
}

const ATTACH_SIDES = new Set(["left", "right", "top", "bottom"]);

function validAttach(raw: unknown): raw is LayeredScreenshotAttach | null {
  if (raw === null) return true;
  const attach = raw as LayeredScreenshotAttach | undefined;
  return (
    !!attach &&
    typeof attach === "object" &&
    typeof attach.to === "string" &&
    ATTACH_SIDES.has(attach.side)
  );
}

function validItem(raw: unknown): raw is LayeredScreenshotItem {
  const item = raw as LayeredScreenshotItem | null;
  if (!item || typeof item !== "object" || typeof item.id !== "string") return false;
  if (!validAttach(item.attach)) return false;
  if (item.gap !== undefined && !(Number.isFinite(item.gap) && item.gap >= 0)) return false;
  if (item.kind === "screen") {
    return (
      typeof item.src === "string" &&
      item.src.length > 0 &&
      (item.media === "image" || item.media === "video")
    );
  }
  if (item.kind === "text") {
    return item.width === undefined || (Number.isFinite(item.width) && item.width > 0);
  }
  return false;
}

/** Keeps the items whose attach chains terminate at the layer's single root: one root (the first attach:null wins), resolvable in-layer refs, no cycles; everything else drops with a note. */
function normalizeItems(rawItems: unknown[], source: string): LayeredScreenshotItem[] {
  const items: LayeredScreenshotItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (!validItem(raw)) {
      console.warn(`[layeredScreenshot] ${source}: invalid item, dropped`);
      continue;
    }
    if (seen.has(raw.id)) {
      console.warn(`[layeredScreenshot] ${source}: duplicate item id "${raw.id}", dropped`);
      continue;
    }
    seen.add(raw.id);
    items.push(raw);
  }
  const rootId = items.find((i) => i.attach === null)?.id;
  if (rootId === undefined) {
    if (items.length > 0) console.warn(`[layeredScreenshot] ${source}: no root item, layer empty`);
    return [];
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const rooted = (item: LayeredScreenshotItem): boolean => {
    let current = item;
    for (let hop = 0; hop <= items.length; hop++) {
      if (current.id === rootId) return true;
      if (current.attach === null) return false; // a second root
      const next = byId.get(current.attach.to);
      if (!next) return false;
      current = next;
    }
    return false; // cycle
  };
  const kept = items.filter(rooted);
  if (kept.length < items.length) {
    console.warn(
      `[layeredScreenshot] ${source}: ${items.length - kept.length} unrooted item(s) dropped`,
    );
  }
  return kept;
}

function normalizeTrack(
  raw: NonNullable<SceneDoc["layeredScreenshot"]>["animation"],
  source: string,
): LayeredScreenshotTrack | null {
  if (!raw) return null;
  const keys: LayeredScreenshotKey[] = [];
  const seen = new Set<string>();
  for (const key of raw.keys ?? []) {
    if (
      !key ||
      typeof key.id !== "string" ||
      !Number.isFinite(key.tMs) ||
      !validLayeredScreenshotPose(key.pose)
    ) {
      console.warn(`[layeredScreenshot] ${source}: invalid animation key, dropped`);
      continue;
    }
    if (seen.has(key.id)) {
      console.warn(`[layeredScreenshot] ${source}: duplicate key id "${key.id}", dropped`);
      continue;
    }
    seen.add(key.id);
    keys.push(key.tMs < 0 ? { ...key, tMs: 0 } : key);
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.tMs - b.tMs);

  const byId = new Map(keys.map((k) => [k.id, k]));
  const segments: LayeredScreenshotTrackSegment[] = [];
  for (const seg of raw.segments ?? []) {
    const from = seg ? byId.get(seg.from) : undefined;
    const to = seg ? byId.get(seg.to) : undefined;
    if (!from || !to || from.tMs >= to.tMs) {
      console.warn(`[layeredScreenshot] ${source}: invalid animation segment, dropped`);
      continue;
    }
    if (typeof seg.ease === "string" && !isEaseName(seg.ease)) {
      console.warn(`[layeredScreenshot] ${source}: unknown ease "${seg.ease}", renders as default`);
    }
    segments.push({ from, to, ease: seg.ease });
  }
  segments.sort((a, b) => a.from.tMs - b.from.tMs);
  const ordered: LayeredScreenshotTrackSegment[] = [];
  for (const seg of segments) {
    const prev = ordered[ordered.length - 1];
    if (prev && seg.from.tMs < prev.to.tMs) {
      console.warn(`[layeredScreenshot] ${source}: overlapping animation segment, dropped`);
      continue;
    }
    ordered.push(seg);
  }
  return { keys, segments: ordered };
}

/** Validate + normalize a sidecar layeredScreenshot value. Null only when absent; a present block always normalizes (possibly to empty layers), so the builder can edit what survived. */
export function normalizeLayeredScreenshot(
  raw: SceneDoc["layeredScreenshot"],
  source: string,
): NormalizedLayeredScreenshot | null {
  if (!raw) return null;
  const layers: LayeredScreenshotLayer[] = [];
  const seenLayers = new Set<string>();
  for (const layer of raw.layers) {
    if (
      !layer ||
      typeof layer !== "object" ||
      typeof layer.id !== "string" ||
      !Array.isArray(layer.items)
    ) {
      console.warn(`[layeredScreenshot] ${source}: invalid layer, dropped`);
      continue;
    }
    if (seenLayers.has(layer.id)) {
      console.warn(`[layeredScreenshot] ${source}: duplicate layer id "${layer.id}", dropped`);
      continue;
    }
    seenLayers.add(layer.id);
    layers.push({
      id: layer.id,
      ...(typeof layer.name === "string" ? { name: layer.name } : {}),
      visible: layer.visible !== false,
      items: normalizeItems(layer.items, `${source} layer "${layer.id}"`),
      ...(Number.isFinite(layer.gap) && (layer.gap as number) >= 0 ? { gap: layer.gap } : {}),
      ...(typeof layer.flat === "boolean" ? { flat: layer.flat } : {}),
      z: Number.isFinite(layer.z) ? layer.z : 0,
    });
  }
  const pose: LayeredScreenshotPose = {
    spread: clamp(raw.pose.spread, 0, 1),
    azimuthDeg: raw.pose.azimuthDeg,
    elevationDeg: raw.pose.elevationDeg,
    zoom: clamp(raw.pose.zoom, 0.05, 20),
    pan: [raw.pose.pan[0], raw.pose.pan[1]],
  };
  return { layers, pose, track: normalizeTrack(raw.animation, source) };
}

function mixPose(
  a: LayeredScreenshotPose,
  b: LayeredScreenshotPose,
  t: number,
): LayeredScreenshotPose {
  return {
    spread: lerp(a.spread, b.spread, t),
    azimuthDeg: lerp(a.azimuthDeg, b.azimuthDeg, t),
    elevationDeg: lerp(a.elevationDeg, b.elevationDeg, t),
    zoom: lerp(a.zoom, b.zoom, t),
    pan: [lerp(a.pan[0], b.pan[0], t), lerp(a.pan[1], b.pan[1], t)],
  };
}

/** Sample a normalized track at scene-local time: eased interpolation inside a segment, hold the latest key outside (the sceneCamera semantics, byte for byte). */
export function sampleLayeredScreenshotTrack(
  track: LayeredScreenshotTrack,
  localMs: number,
): LayeredScreenshotPose {
  for (const seg of track.segments) {
    if (localMs >= seg.from.tMs && localMs < seg.to.tMs) {
      const p = (localMs - seg.from.tMs) / (seg.to.tMs - seg.from.tMs);
      return mixPose(seg.from.pose, seg.to.pose, ease(seg.ease, p));
    }
  }
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return { ...held.pose, pan: [...held.pose.pan] };
}

/** The pose a scene's stack renders with: the sampled animation when this scene's animated track is the layered screenshot, else the saved rest pose regardless of what is on disk. */
export function resolveLayeredScreenshotPose(
  normalized: NormalizedLayeredScreenshot,
  animatedTrack: SceneDoc["animatedTrack"],
  localMs: number,
): LayeredScreenshotPose {
  if (animatedTrack === "layeredScreenshot" && normalized.track) {
    return sampleLayeredScreenshotTrack(normalized.track, localMs);
  }
  return normalized.pose;
}
