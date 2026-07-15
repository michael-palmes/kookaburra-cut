/** Design-token TYPES: the single themeable layer; scenes read a resolved `Theme` via `useTheme()` and must never hard-code colours, type or motion values. Theme VALUES live in JSON documents (schema v2 - `src/theme/builtin/*.json` bundled, `~/Kookaburra Cut/themes/<slug>/theme.json` user-created), parsed by `theme/schema.ts` and resolved by `theme/registry.ts`. This module stays pure types so it's unit-testable and importable anywhere. */

/** Bloom / glow params (see engine/effects.ts). `intensity` 0 = no bloom. */
export interface BloomParams {
  intensity: number;
  luminanceThreshold: number;
  luminanceSmoothing: number;
}

/** Vignette params. `darkness` 0 = no vignette. */
export interface VignetteParams {
  offset: number;
  darkness: number;
}

/** Colour-grade params: `url` is a project-relative `.cube` 3D LUT (e.g. "assets/grade.cube"), resolved by loadProject to a project asset key. `intensity` 0 = no grade, 1 = full grade (drives blend opacity). All LUTs in one project must share one LUT_3D_SIZE (see preloadEffectLuts). */
export interface LutParams {
  url: string;
  intensity: number;
}

/** Film-grain params. `intensity` 0 = no grain. Seeded from the frame only (see grainSeed). */
export interface GrainParams {
  intensity: number;
}

/** The postprocessing stack: every field is a plain number/string set on the CPU, never time-derived, so effect frames stay a pure function of the timeline. Omitting a key omits that effect. A theme with NO `effects` keeps the byte-identical (composer-free) render path. See docs/determinism.md. */
export interface EffectsConfig {
  bloom?: BloomParams;
  vignette?: VignetteParams;
  lut?: LutParams;
  grain?: GrainParams;
}

/** A per-scene override: any subset of the effect stack, each effect itself partial. */
export type EffectsOverride = {
  [K in keyof EffectsConfig]?: Partial<EffectsConfig[K]>;
};

// v8 (Themes & Light) token groups: every group below is OPTIONAL, an absent group resolves to the legacy pre-v8 code path verbatim (the null-for-legacy contract keeping standing baselines byte-identical). See docs/determinism.md ("Themes & per-scene render state").

export type ThemeMode = "light" | "dark";

/** One directional light, aimed at the origin from an orbit direction (the pose idiom). */
export interface ThemeLightSpec {
  azimuthDeg: number;
  elevationDeg: number;
  intensity: number;
  /** sRGB hex; defaults to white. */
  color?: string;
}

/** Shadow-map tokens: fixed values are an EXPORT CONTRACT (the GSAA σ²/κ precedent). Shadows render only when a scene stages a floor/backdrop (hybrid decision); the v7 procedural blob shadows remain the default everywhere else. */
export interface ThemeShadowSpec {
  technique: "map" | "none";
  /** 0..1 penumbra scale (drives the light's shadow radius). */
  softness: number;
  /** 0..1 darkening of the shadow catcher. */
  opacity: number;
  mapSize: number;
  bias: number;
  /** Shadow tint on the catcher (sRGB hex; default black). Light themes want a hair of colour, pure black shadows read synthetic on white floors. */
  color?: string;
}

export interface ThemeLighting {
  key: ThemeLightSpec;
  fills: ThemeLightSpec[];
  ambient: number;
  shadow?: ThemeShadowSpec;
}

/** Environment reflections (IBL): `source` is a bundled HDRI id (`kookaburra:<name>`), a Lightformer preset id (`kookaburra:softbox`), or a project-relative `.hdr` path (user themes). Preloaded before frame 0 via `preloadEnvironments`. */
export interface ThemeEnvironment {
  source: string;
  intensity: number;
  rotationDeg: number;
}

/** Structured, renderable gradient (schema v2; CSS strings are gone). `type: "radial"` runs centre to corners (`angleDeg` ignored); `space: "oklch"` selects perceptual stop interpolation. Absent `space` is the per-channel sRGB byte path, byte-frozen by the standing baselines. */
export interface GradientSpec {
  type: "linear" | "radial";
  angleDeg: number;
  /** Ordered [sRGB hex, position 0..1] pairs. */
  stops: [string, number][];
  space?: "oklch";
}

/** Default staging. Scenes can override via their sidecar; `none` = flat colour. */
export type ThemeBackdrop =
  | { type: "none" }
  | { type: "floor"; color: string; filletRadius?: number }
  /** `gradient` names a THEME gradient; `spec` carries an inline self-contained gradient (the unified Background editor's write-through). One must be present; `spec` wins when both are. */
  | { type: "gradient"; gradient?: string; spec?: GradientSpec }
  | { type: "image"; src: string; fit?: "cover" | "contain" };

/** Camera-locked, frame-filling background, drawn behind ALL world content and COMPOSABLE with `backdrop` (a fixed image can sit behind a shadowed cyclorama). Vocabulary: `colors.background` clears the frame, `background` is a camera-locked fill over that clear and behind world content, `backdrop` is world-space staging. Image/gradient fills cover-crop, centred, one asset serves every aspect. `parallax` (0..0.5, default 0 = hard-locked) drifts the fill at that fraction of the content's screen motion; `image.src` is `kookaburra:<name>` (bundled) or a project-relative path. */
export type ThemeBackground =
  | { type: "none" }
  | { type: "color"; color: string; parallax?: number }
  /** `gradient` names a THEME gradient; `spec` (the picker) carries an inline self-contained gradient, theme-independent presets/customs. One must be present; `spec` wins when both are. */
  | { type: "gradient"; gradient?: string; spec?: GradientSpec; parallax?: number }
  | { type: "image"; src: string; parallax?: number }
  /** A looping video fill riding the clip frame pipeline. SCENE-DOC ONLY (decision 5: themes are workspace-shared and can't reference project assets; the theme parser drops it). Absent `loop` = true; `loop: false` holds the last frame. */
  | { type: "video"; src: string; parallax?: number; loop?: boolean }
  /** An animated GLSL fill (the vendored paper-design pack): `shader` names a SHADER_BACKGROUNDS id, `colors` are hexes filling the effect's slots, `speed` multiplies the ABSOLUTE project clock (continuous across scene cuts), `params` are the effect's own numeric knobs. Theme-safe (no asset references). */
  | {
      type: "shader";
      shader: string;
      colors?: string[];
      speed?: number;
      scale?: number;
      params?: Record<string, number>;
      parallax?: number;
      /** Bundled preset id last applied by the picker; the renderer never reads it, only the inspector's Reset and tile highlight do. */
      preset?: string;
    };

/** Named text in/out animation presets, overridable per primitive and per scene via the sidecar's `textAnimation` (whole-spec, the backdrop pattern). Later params are additive optionals themeing the motion pack. */
export interface TextAnimationSpec {
  in: string;
  out: string;
  staggerMs: number;
  /** Stagger granularity when staggerMs > 0 (default "word"). */
  stagger?: "char" | "word";
  /** fade-scale: starting scale, landing at 1 (clamped 0.05-4 at resolve; default 0.8). */
  startScale?: number;
  /** fade-scale: sweep the soft white shine band once during the scale-in. */
  shine?: boolean;
  /** twist-scale: which side the card turns in from (default "from-left"). */
  direction?: "from-left" | "from-right";
  /** all-at-once forces the block path; paragraphs split on `\n`, groups on blank lines. */
  delivery?: "all-at-once" | "by-paragraph" | "by-paragraph-group";
}

/** A resolved font reference. `family` resolves through the bundled registry first, then workspace-pinned system fonts (`~/Kookaburra Cut/fonts/`, auto-pinned on first reference), else falls back to Inter with a warning. Weights snap to the nearest available static face. */
export interface FontRef {
  family: string;
  weight: number;
}

export interface Theme {
  /** Stable id; what `project.json.themeId` matches (`kookaburra-*` bundled, `ws:<slug>` user). */
  id: string;
  /** Display name for pickers. */
  name: string;
  mode?: ThemeMode;
  colors: {
    background: string;
    text: string;
    accent: string;
    muted: string;
  };
  gradients?: Record<string, GradientSpec>;
  typography: {
    headline: FontRef;
    body: FontRef;
    /** Modular scale ratio between type steps. */
    scale: number;
  };
  motion: {
    /** Milliseconds. */
    durations: { fast: number; base: number; slow: number };
    /** anime.js / d3-ease easing names. */
    easings: { standard: string; emphasized: string };
  };
  textAnimation?: TextAnimationSpec;
  lighting?: ThemeLighting;
  environment?: ThemeEnvironment;
  backdrop?: ThemeBackdrop;
  background?: ThemeBackground;
  /** Project-wide postprocessing defaults; optional and absent by default. A theme without `effects` renders through the original composer-free path, preserving the v0-v2 byte-identical export. Per-scene overrides layer on top via `resolveEffectParams`. */
  effects?: EffectsConfig;
}
