import type { CompareTrackDoc } from "../../engine/compareEditStore";
import { DEFAULT_EASE, isEaseName } from "../../engine/ease";
import { MIN_KEY_GAP_MS } from "../../engine/keyedTrack";

/** The comparison drill's Animation fields mapped to and from the divider track, the one place that owns the translation. Reading detects the SIMPLE shape (at most two keys and at most one segment, which is what the reveal and hold presets write) and round-trips it; richer tracks still report their derived first/last values so the fields can replace them on the next edit. Writing always produces one two-key track plus one segment, whole-ms and clamped to the scene, the camera-preset rule: real keys, hand-tunable in the lane afterwards. An angle field left unset writes NO `pose.angleDeg`, so the static mask angle keeps holding and angle-free docs stay byte-identical. */

/** The fields the drill shows: the divider's start and end position, the motion window, its ease, and the optional keyed angles. */
export interface CompareAnimationFields {
  /** Divider position at the start of the motion (0..1). */
  fromValue: number;
  /** Divider position at the end of the motion (0..1). */
  toValue: number;
  /** Scene-local start of the motion, whole ms. */
  startMs: number;
  /** Length of the motion, whole ms. */
  durationMs: number;
  /** An `engine/ease.ts` name; unknown names read and write as the default. */
  ease: string;
  /** Divider angle at the start; undefined means the static mask angle. */
  angleFromDeg?: number;
  /** Divider angle at the end; undefined means the static mask angle. */
  angleToDeg?: number;
}

/** `empty`: no keys, the fields show seeding defaults. `simple`: the two-key shape these fields own. `rich`: a hand-edited or multi-key track the fields would replace. */
export type CompareAnimationShape = "empty" | "simple" | "rich";

export interface CompareAnimationRead {
  shape: CompareAnimationShape;
  /** Keys the track actually holds; the rich note counts these. */
  keyCount: number;
  fields: CompareAnimationFields;
}

/** The static divider state the fields fall back to: `compare.value` seeds From with no keys, `compare.mask.angleDeg` is what an unset angle field means. */
export interface CompareAnimationStatics {
  value?: number;
  angleDeg?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const whole = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
const easeOf = (name: string | undefined) => (name && isEaseName(name) ? name : DEFAULT_EASE);

/** The seeded motion length: 85% of the scene, the reveal preset's span. */
const seedDurationMs = (sceneDurationMs: number) =>
  Math.max(MIN_KEY_GAP_MS, Math.round(Math.max(0, whole(sceneDurationMs)) * 0.85));

/** Derive the Animation fields from the current track. `statics` carries the compare block's static divider value and mask angle, which seed the fields when nothing is keyed yet. */
export function readCompareAnimationFields(
  track: CompareTrackDoc | undefined,
  statics: CompareAnimationStatics,
  sceneDurationMs: number,
): CompareAnimationRead {
  const keys = [...(track?.keys ?? [])].sort((a, b) => a.tMs - b.tMs);
  const segments = track?.segments ?? [];
  if (keys.length === 0) {
    return {
      shape: "empty",
      keyCount: 0,
      fields: {
        fromValue: clamp01(statics.value ?? 0.5),
        toValue: 0,
        startMs: 0,
        durationMs: seedDurationMs(sceneDurationMs),
        ease: DEFAULT_EASE,
      },
    };
  }
  const first = keys[0];
  const last = keys[keys.length - 1];
  const startMs = Math.max(0, whole(first.tMs));
  const span = Math.max(0, whole(last.tMs) - startMs);
  const byId = new Map(keys.map((k) => [k.id, k]));
  const earliest = segments
    .filter((s) => byId.has(s.from) && byId.has(s.to))
    .sort((a, b) => (byId.get(a.from)?.tMs ?? 0) - (byId.get(b.from)?.tMs ?? 0))[0];
  return {
    shape: keys.length <= 2 && segments.length <= 1 ? "simple" : "rich",
    keyCount: keys.length,
    fields: {
      fromValue: clamp01(first.pose.value),
      toValue: clamp01(last.pose.value),
      startMs,
      durationMs: span > 0 ? span : seedDurationMs(sceneDurationMs),
      ease: easeOf(earliest?.ease),
      angleFromDeg: first.pose.angleDeg,
      angleToDeg: last.pose.angleDeg,
    },
  };
}

/** Build the whole track the fields describe: keys `k1`/`k2` joined by one eased segment, times whole and inside the scene, angles written only where the caller set one. */
export function buildCompareAnimationTrack(
  fields: CompareAnimationFields,
  sceneDurationMs: number,
): CompareTrackDoc {
  const scene = Math.max(0, whole(sceneDurationMs));
  const startMs = clamp(whole(fields.startMs), 0, Math.max(0, scene - MIN_KEY_GAP_MS));
  const span = Math.max(MIN_KEY_GAP_MS, whole(fields.durationMs));
  const endMs = Math.min(startMs + span, Math.max(scene, startMs + MIN_KEY_GAP_MS));
  const pose = (value: number, angleDeg: number | undefined) =>
    angleDeg !== undefined && Number.isFinite(angleDeg)
      ? { value: clamp01(value), angleDeg }
      : { value: clamp01(value) };
  return {
    keys: [
      { id: "k1", tMs: startMs, pose: pose(fields.fromValue, fields.angleFromDeg) },
      { id: "k2", tMs: endMs, pose: pose(fields.toValue, fields.angleToDeg) },
    ],
    segments: [{ from: "k1", to: "k2", ease: easeOf(fields.ease) }],
  };
}
