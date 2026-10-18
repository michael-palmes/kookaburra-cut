import { linearToSrgb, srgbToLinear } from "../theme/oklch";
import type { LightingPose, LightingSpec, Theme } from "../theme/tokens";
import { DEFAULT_EASE, ease, isEaseName } from "./ease";
import { KELVIN_MAX, KELVIN_MIN } from "./kelvin";
import type {
  SceneDoc,
  SceneDocRoom,
  SceneDocRoomLightEntry,
  SceneDocRoomLighting,
} from "./sceneDocSchema";
import { type RoomPoseAt, resolveLighting, resolveLightingColour } from "./sceneLighting";

/** Rooms: a scene's backdrop colour changing mid-scene by a cut or a flood spreading from a point, with the staged lights following. The sidecar `room` block parses shallowly (raw keys survive so a write never drops data), this module validates it with warnings at load and silently at build, and every sample is a pure function of scene-local time. A project with no `room` anywhere builds null tracks and never reaches any of it. See docs/determinism.md ("Rooms"). */

export type RoomTransition = "cut" | "flood";

export const ROOM_TRANSITIONS: readonly RoomTransition[] = ["cut", "flood"];
export const ROOM_KEY_FIELDS: readonly string[] = [
  "at",
  "colour",
  "themeId",
  "lighting",
  "transition",
  "origin",
  "durationMs",
  "ease",
];
export const ROOM_LIGHTING_FIELDS: readonly string[] = ["sun", "ambient", "ambientColor", "lights"];
export const ROOM_LIGHT_FIELDS: readonly string[] = ["intensity", "color", "colorToken", "kelvin"];
/** Default flood length, ms. */
export const ROOM_FLOOD_MS = 800;
/** The frame centre; origins are frame fractions, top-left [0, 0] to bottom-right [1, 1]. */
export const ROOM_DEFAULT_ORIGIN: readonly [number, number] = Object.freeze([0.5, 0.5]) as [
  number,
  number,
];
export const ROOM_FLOOD_SEGMENTS = 256;
/** Cover-radius overscan: the frame-edge seam margin of the fixed background. */
const ROOM_COVER_OVERSCAN = 1.001;

const THEME_COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type Palette = Theme["colors"];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type RoomWarn = (message: string) => void;
const silent: RoomWarn = () => {};

/** The seam musical positions plug into: a key's `at` as scene-local ms, or null when it can't resolve. Numbers only today. */
export function resolveRoomAt(at: unknown): number | null {
  return isNum(at) ? Math.max(0, at) : null;
}

/** A hex (`#rgb` or `#rrggbb`) as lower-case `#rrggbb`; anything else passes through. */
export function normaliseHex(value: string): string {
  if (!HEX_RE.test(value)) return value;
  const h = value.slice(1).toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

const isColourToken = (v: string): v is keyof Palette =>
  (THEME_COLOUR_TOKENS as readonly string[]).includes(v);

/** A key or lighting colour: a hex, or a theme colour token resolved against the room's palette. */
function resolveColour(value: string, palette: Palette): string | null {
  if (HEX_RE.test(value)) return normaliseHex(value);
  if (isColourToken(value)) return normaliseHex(palette[value]);
  return null;
}

const validColour = (v: unknown): v is string => isStr(v) && (HEX_RE.test(v) || isColourToken(v));

function warnUnknown(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  warn: RoomWarn,
) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) warn(`${label}.${key} isn't a room field, ignored`);
  }
}

function validLightEntry(
  raw: unknown,
  label: string,
  warn: RoomWarn,
): SceneDocRoomLightEntry | null {
  if (!isRecord(raw)) {
    warn(`${label} isn't an object, dropped`);
    return null;
  }
  warnUnknown(raw, ROOM_LIGHT_FIELDS, label, warn);
  const out: SceneDocRoomLightEntry = {};
  if (isNum(raw.intensity)) out.intensity = Math.max(0, raw.intensity);
  else if (raw.intensity !== undefined) warn(`${label}.intensity isn't a number, dropped`);
  if (isNum(raw.kelvin)) out.kelvin = clamp(raw.kelvin, KELVIN_MIN, KELVIN_MAX);
  else if (raw.kelvin !== undefined) warn(`${label}.kelvin isn't a number, dropped`);
  if (isStr(raw.colorToken) && isColourToken(raw.colorToken)) out.colorToken = raw.colorToken;
  else if (raw.colorToken !== undefined) {
    warn(`${label}.colorToken isn't one of ${THEME_COLOUR_TOKENS.join(", ")}, dropped`);
  }
  if (isStr(raw.color) && HEX_RE.test(raw.color)) out.color = raw.color;
  else if (raw.color !== undefined) warn(`${label}.color isn't a hex colour, dropped`);
  return Object.keys(out).length > 0 ? out : null;
}

function validLighting(raw: unknown, label: string, warn: RoomWarn): SceneDocRoomLighting | null {
  if (!isRecord(raw)) {
    warn(`${label} isn't an object, dropped`);
    return null;
  }
  warnUnknown(raw, ROOM_LIGHTING_FIELDS, label, warn);
  const out: SceneDocRoomLighting = {};
  if (raw.sun !== undefined) {
    const sun = validLightEntry(raw.sun, `${label}.sun`, warn);
    if (sun) out.sun = sun;
  }
  if (isNum(raw.ambient)) out.ambient = Math.max(0, raw.ambient);
  else if (raw.ambient !== undefined) warn(`${label}.ambient isn't a number, dropped`);
  if (validColour(raw.ambientColor)) out.ambientColor = raw.ambientColor;
  else if (raw.ambientColor !== undefined) {
    warn(`${label}.ambientColor isn't a hex colour or theme colour token, dropped`);
  }
  if (isRecord(raw.lights)) {
    const lights: Record<string, SceneDocRoomLightEntry> = {};
    for (const [id, value] of Object.entries(raw.lights)) {
      const entry = validLightEntry(value, `${label}.lights.${id}`, warn);
      if (entry) lights[id] = entry;
    }
    if (Object.keys(lights).length > 0) out.lights = lights;
  } else if (raw.lights !== undefined)
    warn(`${label}.lights isn't an object keyed by light id, dropped`);
  return Object.keys(out).length > 0 ? out : null;
}

/** One validated key, everything defaulted; `durationMs` is 0 for a cut. */
export interface RoomKeyFields {
  at: number;
  colour?: string;
  themeId?: string;
  lighting?: SceneDocRoomLighting;
  transition: RoomTransition;
  origin: [number, number];
  durationMs: number;
  ease: string;
}

/** Validate one raw key (degrade, don't crash): a bad field drops, a key with no usable `at` or no content drops whole. */
export function validateRoomKey(
  raw: unknown,
  label: string,
  warn: RoomWarn = silent,
): RoomKeyFields | null {
  if (!isRecord(raw)) {
    warn(`${label} isn't an object, dropped`);
    return null;
  }
  warnUnknown(raw, ROOM_KEY_FIELDS, label, warn);
  const at = resolveRoomAt(raw.at);
  if (at === null) {
    warn(
      typeof raw.at === "string"
        ? `${label}.at "${raw.at}" isn't supported yet (scene-local ms only), key dropped`
        : `${label} needs a numeric "at" (scene-local ms), key dropped`,
    );
    return null;
  }
  const out: RoomKeyFields = {
    at,
    transition: "cut",
    origin: [ROOM_DEFAULT_ORIGIN[0], ROOM_DEFAULT_ORIGIN[1]],
    durationMs: 0,
    ease: DEFAULT_EASE,
  };
  if (validColour(raw.colour)) out.colour = raw.colour;
  else if (raw.colour !== undefined) {
    warn(
      `${label}.colour isn't a hex colour or theme colour token (${THEME_COLOUR_TOKENS.join(", ")}), dropped`,
    );
  }
  if (isStr(raw.themeId)) out.themeId = raw.themeId;
  else if (raw.themeId !== undefined) warn(`${label}.themeId isn't a theme id, dropped`);
  if (raw.lighting !== undefined) {
    const lighting = validLighting(raw.lighting, `${label}.lighting`, warn);
    if (lighting) out.lighting = lighting;
  }
  if (raw.transition !== undefined) {
    if (ROOM_TRANSITIONS.includes(raw.transition as RoomTransition)) {
      out.transition = raw.transition as RoomTransition;
    } else warn(`${label}.transition isn't cut or flood, using cut`);
  }
  if (Array.isArray(raw.origin) && raw.origin.length === 2 && raw.origin.every(isNum)) {
    out.origin = [raw.origin[0] as number, raw.origin[1] as number];
  } else if (raw.origin !== undefined)
    warn(`${label}.origin isn't [x, y] frame fractions, using the centre`);
  if (raw.ease !== undefined) {
    if (isEaseName(raw.ease)) out.ease = raw.ease;
    else warn(`${label}.ease "${String(raw.ease)}" isn't an ease name, using ${DEFAULT_EASE}`);
  }
  if (out.transition === "flood") {
    out.durationMs = ROOM_FLOOD_MS;
    if (isNum(raw.durationMs) && raw.durationMs > 0) out.durationMs = raw.durationMs;
    else if (raw.durationMs !== undefined)
      warn(`${label}.durationMs isn't a positive number, using ${ROOM_FLOOD_MS}`);
  }
  if (!out.colour && !out.themeId && !out.lighting) {
    warn(`${label} needs a colour, a themeId or lighting, key dropped`);
    return null;
  }
  return out;
}

/** Validate every key, sort by `at` (stable), and end each flood by the next key's `at`. */
export function validateRoomKeys(
  raw: readonly unknown[],
  label: string,
  warn: RoomWarn = silent,
): RoomKeyFields[] {
  const keys: RoomKeyFields[] = [];
  raw.forEach((entry, i) => {
    const key = validateRoomKey(entry, `${label}.keys[${i}]`, warn);
    if (key) keys.push(key);
  });
  keys.sort((a, b) => a.at - b.at);
  for (let i = 0; i + 1 < keys.length; i++) {
    const room = keys[i];
    const gap = keys[i + 1].at - room.at;
    if (room.durationMs > gap) {
      warn(
        `${label}: the flood at ${room.at}ms runs past the next key at ${keys[i + 1].at}ms, shortened`,
      );
      room.durationMs = gap;
    }
  }
  return keys;
}

/** The distinct theme ids room keys name, for the project load to resolve. */
export function collectRoomThemeIds(docs: readonly (SceneDoc | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const doc of docs) {
    for (const key of doc?.room?.keys ?? []) {
      if (isRecord(key) && isStr(key.themeId)) ids.add(key.themeId);
    }
  }
  return [...ids];
}

export interface RoomTrackKey {
  at: number;
  /** The room colour once this key lands, `#rrggbb`. */
  colour: string;
  transition: RoomTransition;
  origin: [number, number];
  durationMs: number;
  ease: string;
  /** Complete over every field any key touches, so floods lerp from real values. */
  pose: LightingPose;
}

export interface RoomTrack {
  keys: RoomTrackKey[];
  /** The scene's own values for every field the keys touch; a first flood lerps from here. */
  basePose: LightingPose;
}

export interface RoomTrackContext {
  sceneTheme: Theme;
  /** Themes room keys name (`LoadedProject.roomThemes`); an id missing here reads the scene's theme. */
  roomThemes?: Readonly<Record<string, Theme>>;
  projectLighting?: LightingSpec;
  docLighting?: LightingSpec;
}

interface BaseLights {
  sun?: { intensity: number; color: string };
  ambient?: number;
  ambientColor?: string;
  lights: Map<string, { intensity: number; color: string }>;
  spec: LightingSpec | undefined;
}

function baseLights(ctx: RoomTrackContext): BaseLights {
  const spec = resolveLighting(ctx.sceneTheme.lighting, ctx.projectLighting, ctx.docLighting);
  const colors = ctx.sceneTheme.colors;
  const out: BaseLights = { lights: new Map(), spec };
  if (spec?.sun && spec.sun.enabled !== false) {
    out.sun = {
      intensity: spec.sun.intensity,
      color: normaliseHex(resolveLightingColour(spec.sun, colors)),
    };
  }
  if (spec?.ambient !== undefined) {
    out.ambient = spec.ambient;
    out.ambientColor = normaliseHex(spec.ambientColor ?? "#ffffff");
  }
  for (const light of spec?.lights ?? []) {
    out.lights.set(light.id, {
      intensity: light.intensity,
      color: normaliseHex(resolveLightingColour(light, colors)),
    });
  }
  return out;
}

function entryColour(entry: SceneDocRoomLightEntry, palette: Palette): string | undefined {
  if (entry.kelvin === undefined && entry.colorToken === undefined && entry.color === undefined) {
    return undefined;
  }
  return normaliseHex(resolveLightingColour(entry, palette));
}

type PoseLight = NonNullable<LightingPose["lights"]>[string];

/** One key's sparse pose: lights tokened to a theme colour follow the room's palette, a `themeId` brings that theme's sun, ambient and same-id lights (intensity and colour only; rooms never move a light), and the key's own `lighting` wins. */
function rawRoomPose(
  key: RoomKeyFields,
  palette: Palette,
  base: BaseLights,
  roomTheme: Theme | undefined,
): LightingPose {
  const pose: LightingPose = {};
  const sun: NonNullable<LightingPose["sun"]> = {};
  const lights: Record<string, PoseLight> = {};
  const light = (id: string): PoseLight => {
    lights[id] ??= {};
    return lights[id];
  };
  const spec = base.spec;
  if (base.sun && spec?.sun && spec.sun.kelvin === undefined && spec.sun.colorToken) {
    const token = spec.sun.colorToken;
    if (isColourToken(token)) sun.color = normaliseHex(palette[token]);
  }
  for (const l of spec?.lights ?? []) {
    if (l.kelvin === undefined && l.colorToken && isColourToken(l.colorToken)) {
      light(l.id).color = normaliseHex(palette[l.colorToken]);
    }
  }
  const themed = roomTheme?.lighting;
  if (themed) {
    if (base.sun && themed.sun) {
      sun.intensity = themed.sun.intensity;
      sun.color = normaliseHex(resolveLightingColour(themed.sun, palette));
    }
    if (base.ambient !== undefined && themed.ambient !== undefined) {
      pose.ambient = themed.ambient;
      pose.ambientColor = normaliseHex(themed.ambientColor ?? "#ffffff");
    }
    for (const l of themed.lights ?? []) {
      if (!base.lights.has(l.id)) continue;
      light(l.id).intensity = l.intensity;
      light(l.id).color = normaliseHex(resolveLightingColour(l, palette));
    }
  }
  const own = key.lighting;
  if (own) {
    if (base.sun && own.sun) {
      if (own.sun.intensity !== undefined) sun.intensity = own.sun.intensity;
      const color = entryColour(own.sun, palette);
      if (color) sun.color = color;
    }
    if (base.ambient !== undefined) {
      if (own.ambient !== undefined) pose.ambient = own.ambient;
      const color = own.ambientColor ? resolveColour(own.ambientColor, palette) : null;
      if (color) pose.ambientColor = color;
    }
    for (const [id, entry] of Object.entries(own.lights ?? {})) {
      if (!base.lights.has(id)) continue;
      if (entry.intensity !== undefined) light(id).intensity = entry.intensity;
      const color = entryColour(entry, palette);
      if (color) light(id).color = color;
    }
  }
  if (Object.keys(sun).length > 0) pose.sun = sun;
  if (Object.keys(lights).length > 0) pose.lights = lights;
  return pose;
}

/** Fill a sparse pose to the union of touched fields from the scene's own values. */
function fillPose(raw: LightingPose, union: LightingPose, base: BaseLights): LightingPose {
  const out: LightingPose = {};
  if (union.ambient !== undefined) out.ambient = raw.ambient ?? base.ambient;
  if (union.ambientColor !== undefined) out.ambientColor = raw.ambientColor ?? base.ambientColor;
  if (union.sun && base.sun) {
    const sun: NonNullable<LightingPose["sun"]> = {};
    if (union.sun.intensity !== undefined) sun.intensity = raw.sun?.intensity ?? base.sun.intensity;
    if (union.sun.color !== undefined) sun.color = raw.sun?.color ?? base.sun.color;
    out.sun = sun;
  }
  if (union.lights) {
    const lights: Record<string, PoseLight> = {};
    for (const [id, fields] of Object.entries(union.lights)) {
      const b = base.lights.get(id);
      if (!b) continue;
      const entry: PoseLight = {};
      if (fields.intensity !== undefined)
        entry.intensity = raw.lights?.[id]?.intensity ?? b.intensity;
      if (fields.color !== undefined) entry.color = raw.lights?.[id]?.color ?? b.color;
      lights[id] = entry;
    }
    out.lights = lights;
  }
  return deepFreeze(out);
}

function unionOf(poses: readonly LightingPose[]): LightingPose {
  const union: LightingPose = {};
  for (const pose of poses) {
    if (pose.ambient !== undefined) union.ambient = 0;
    if (pose.ambientColor !== undefined) union.ambientColor = "";
    if (pose.sun) {
      union.sun ??= {};
      if (pose.sun.intensity !== undefined) union.sun.intensity = 0;
      if (pose.sun.color !== undefined) union.sun.color = "";
    }
    for (const [id, entry] of Object.entries(pose.lights ?? {})) {
      union.lights ??= {};
      union.lights[id] ??= {};
      if (entry.intensity !== undefined) union.lights[id].intensity = 0;
      if (entry.color !== undefined) union.lights[id].color = "";
    }
  }
  return union;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Normalise one scene's room block against its theme and lighting; null when no key survives. A key's `themeId` reads that theme's colours and lights, it never swaps the scene's theme. */
export function normalizeRoomTrack(
  room: SceneDocRoom | undefined,
  ctx: RoomTrackContext,
): RoomTrack | null {
  if (!room || !Array.isArray(room.keys)) return null;
  const fields = validateRoomKeys(room.keys, "room");
  if (fields.length === 0) return null;
  const base = baseLights(ctx);
  let colour = normaliseHex(ctx.sceneTheme.colors.background);
  const resolved = fields.map((key) => {
    const roomTheme = key.themeId ? ctx.roomThemes?.[key.themeId] : undefined;
    const colours = roomTheme?.colors ?? ctx.sceneTheme.colors;
    colour =
      (key.colour ? resolveColour(key.colour, colours) : null) ??
      (roomTheme ? normaliseHex(roomTheme.colors.background) : colour);
    const palette: Palette = { ...colours, background: colour };
    return { key, colour, pose: rawRoomPose(key, palette, base, roomTheme) };
  });
  const union = unionOf(resolved.map((r) => r.pose));
  return {
    basePose: fillPose({}, union, base),
    keys: resolved.map(({ key, colour, pose }) => ({
      at: key.at,
      colour,
      transition: key.transition,
      origin: key.origin,
      durationMs: key.durationMs,
      ease: key.ease,
      pose: fillPose(pose, union, base),
    })),
  };
}

export interface RoomThemeInputs {
  sceneThemes: readonly Theme[];
  roomThemes?: Readonly<Record<string, Theme>>;
  projectLighting?: LightingSpec;
}

/** Every scene's room track (index-aligned with the scenes), or null when no scene has one: the byte-identical legacy path. */
export function buildRoomTracks(
  docs: readonly (SceneDoc | undefined)[],
  themes: RoomThemeInputs,
): (RoomTrack | null)[] | null {
  if (!docs.some((doc) => doc?.room)) return null;
  const tracks = themes.sceneThemes.map((sceneTheme, i) => {
    const doc = docs[i];
    if (!doc?.room) return null;
    return normalizeRoomTrack(doc.room, {
      sceneTheme,
      roomThemes: themes.roomThemes,
      projectLighting: themes.projectLighting,
      docLighting: doc.lighting,
    });
  });
  return tracks.some(Boolean) ? tracks : null;
}

export interface RoomFloodSample {
  /** The incoming room. */
  colour: string;
  origin: [number, number];
  /** Linear 0..1 through the flood. */
  progress: number;
  /** Eased fraction of the frame-covering radius. */
  radius: number;
}

export interface RoomSample {
  /** The room on screen (what a flood spreads over); null before the first key, where the scene's own background shows. */
  colour: string | null;
  /** The key the colour belongs to; -1 before the first key. */
  key: number;
  flood: RoomFloodSample | null;
  /** The room's lighting pose; empty before the first key. */
  pose: LightingPose;
}

const EMPTY_POSE: LightingPose = Object.freeze({});

/** Colours lerp in linear light, rounded back to `#rrggbb`; the endpoints return exactly. */
export function mixRoomColour(a: string, b: string, t: number): string {
  if (t <= 0 || a === b) return a;
  if (t >= 1) return b;
  const pa = hexToLinear(a);
  const pb = hexToLinear(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  let out = "#";
  for (let i = 0; i < 3; i++) {
    const v = linearToSrgb(pa[i] + (pb[i] - pa[i]) * t);
    out += Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function hexToLinear(hex: string): [number, number, number] | null {
  const h = normaliseHex(hex);
  if (!/^#[0-9a-f]{6}$/.test(h)) return null;
  return [1, 3, 5].map((i) => srgbToLinear(Number.parseInt(h.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Two complete room poses (same fields) mixed at t. */
export function mixRoomPose(a: LightingPose, b: LightingPose, t: number): LightingPose {
  const out: LightingPose = {};
  if (a.ambient !== undefined) out.ambient = lerp(a.ambient, b.ambient ?? a.ambient, t);
  if (a.ambientColor !== undefined) {
    out.ambientColor = mixRoomColour(a.ambientColor, b.ambientColor ?? a.ambientColor, t);
  }
  if (a.sun) {
    const sun: NonNullable<LightingPose["sun"]> = {};
    if (a.sun.intensity !== undefined) {
      sun.intensity = lerp(a.sun.intensity, b.sun?.intensity ?? a.sun.intensity, t);
    }
    if (a.sun.color !== undefined)
      sun.color = mixRoomColour(a.sun.color, b.sun?.color ?? a.sun.color, t);
    out.sun = sun;
  }
  if (a.lights) {
    const lights: Record<string, PoseLight> = {};
    for (const [id, from] of Object.entries(a.lights)) {
      const to = b.lights?.[id];
      const entry: PoseLight = {};
      if (from.intensity !== undefined) {
        entry.intensity = lerp(from.intensity, to?.intensity ?? from.intensity, t);
      }
      if (from.color !== undefined)
        entry.color = mixRoomColour(from.color, to?.color ?? from.color, t);
      lights[id] = entry;
    }
    out.lights = lights;
  }
  return out;
}

/** The room at scene-local `localMs`: hold the latest key at or before it; inside a flood, the previous room shows with the incoming one growing from `origin` and the lights lerping by the same eased amount. */
export function sampleRoom(track: RoomTrack, localMs: number): RoomSample {
  let k = -1;
  for (let i = 0; i < track.keys.length; i++) {
    if (track.keys[i].at <= localMs) k = i;
    else break;
  }
  if (k < 0) return { colour: null, key: -1, flood: null, pose: EMPTY_POSE };
  const key = track.keys[k];
  const elapsed = localMs - key.at;
  if (key.transition === "flood" && key.durationMs > 0 && elapsed < key.durationMs) {
    const progress = elapsed / key.durationMs;
    const radius = ease(key.ease, progress);
    const prev = k > 0 ? track.keys[k - 1] : null;
    return {
      colour: prev?.colour ?? null,
      key: k - 1,
      flood: { colour: key.colour, origin: key.origin, progress, radius },
      pose: mixRoomPose(prev?.pose ?? track.basePose, key.pose, radius),
    };
  }
  return { colour: key.colour, key: k, flood: null, pose: key.pose };
}

/** The room lighting lookup the lighting plan merges (null for a scene with no room). */
export function roomPoseAt(tracks: readonly (RoomTrack | null)[]): RoomPoseAt {
  return (index, localMs) => {
    const track = tracks[index];
    return track ? sampleRoom(track, localMs).pose : null;
  };
}

/** A flood circle at view distance `distance` in camera space: centre plus radius for a frame-fraction `origin` and a radius fraction, where fraction 1 makes the 256-gon cover the whole frame. */
export function roomFloodCircle(
  fovDeg: number,
  aspect: number,
  distance: number,
  origin: readonly [number, number],
  radius: number,
): { x: number; y: number; r: number } {
  const halfH = distance * Math.tan((fovDeg * Math.PI) / 360);
  const halfW = halfH * aspect;
  const [ox, oy] = origin;
  const reachX = Math.max(Math.abs(ox), Math.abs(1 - ox)) * 2 * halfW;
  const reachY = Math.max(Math.abs(oy), Math.abs(1 - oy)) * 2 * halfH;
  const cover =
    (Math.hypot(reachX, reachY) / Math.cos(Math.PI / ROOM_FLOOD_SEGMENTS)) * ROOM_COVER_OVERSCAN;
  return { x: (2 * ox - 1) * halfW, y: (1 - 2 * oy) * halfH, r: cover * Math.max(0, radius) };
}
