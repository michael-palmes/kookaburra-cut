import { ToneMappingMode } from "postprocessing";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
} from "three";

/** The display transform (v9 · PR 8): an explicit, chosen contract instead of react-three-fiber's inherited default. TWO render paths apply tone mapping (the r3f pipeline for effect-free frames, the composer's ToneMappingEffect for effect frames) and they MUST switch together or they drift. ACES at exposure 1 is the default and matches the previous implicit behaviour exactly: CHANGING THE DEFAULT REBASES EVERY PROJECT. The transition composite's ACES blend pair (acesCurve.ts) deliberately does NOT switch: its seam-exactness rests on the pair being self-inverting, not on matching the display curve (see transitionShader.ts's rationale comment), so a non-ACES display curve only shifts a cross-fade's perceptual midpoint, not its endpoints. */

export type ToneMappingId = "aces" | "agx" | "neutral" | "linear";

export interface RenderSettings {
  toneMapping: ToneMappingId;
  exposure: number;
}

export const DEFAULT_TONE_MAPPING: ToneMappingId = "aces";
export const DEFAULT_EXPOSURE = 1;

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  toneMapping: DEFAULT_TONE_MAPPING,
  exposure: DEFAULT_EXPOSURE,
};

const MODES: ToneMappingId[] = ["aces", "agx", "neutral", "linear"];

/** Exposure authoring range (the UI slider's span; the parser clamps to it). */
export const EXPOSURE_MIN = 0.25;
export const EXPOSURE_MAX = 4;

/** Parse a manifest's `render` block with the usual degrade guard: absent or malformed means ACES at 1.0 (the byte-identical default). */
export function parseRenderSettings(raw: unknown, source: string): RenderSettings {
  if (raw === undefined) return DEFAULT_RENDER_SETTINGS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[render] ${source}: "render" isn't an object — using defaults`);
    return DEFAULT_RENDER_SETTINGS;
  }
  const block = raw as Record<string, unknown>;
  let toneMapping: ToneMappingId = DEFAULT_TONE_MAPPING;
  if (block.toneMapping !== undefined) {
    if (MODES.includes(block.toneMapping as ToneMappingId)) {
      toneMapping = block.toneMapping as ToneMappingId;
    } else {
      console.warn(`[render] ${source}: unknown toneMapping "${block.toneMapping}" — using aces`);
    }
  }
  let exposure = DEFAULT_EXPOSURE;
  if (block.exposure !== undefined) {
    if (typeof block.exposure === "number" && Number.isFinite(block.exposure)) {
      exposure = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, block.exposure));
    } else {
      console.warn(`[render] ${source}: invalid exposure — using 1`);
    }
  }
  return { toneMapping, exposure };
}

/** The r3f-pipeline constant for a mode (three 0.185 ships all four). */
export function threeToneMapping(mode: ToneMappingId): import("three").ToneMapping {
  switch (mode) {
    case "aces":
      return ACESFilmicToneMapping;
    case "agx":
      return AgXToneMapping;
    case "neutral":
      return NeutralToneMapping;
    case "linear":
      return LinearToneMapping;
  }
}

/** The composer-path constant for the same mode (postprocessing 6.39 ships all four); the two paths map one to one and MUST stay in lockstep. */
export function composerToneMapping(mode: ToneMappingId): ToneMappingMode {
  switch (mode) {
    case "aces":
      return ToneMappingMode.ACES_FILMIC;
    case "agx":
      return ToneMappingMode.AGX;
    case "neutral":
      return ToneMappingMode.NEUTRAL;
    case "linear":
      return ToneMappingMode.LINEAR;
  }
}
