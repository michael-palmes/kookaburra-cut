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
  /** False disables real cast shadows and catchers while retaining the configured style. */
  enabled?: boolean;
  /** False keeps floor catching but disables vertical backdrop catching. */
  catchBackdrop?: boolean;
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

// v9 (Scene Lighting) types: the full lighting block shared by all three layers (theme -> project -> scene), each present field fully replacing the layer below (the mergeLighting contract). Absent at every layer resolves to the v8 path verbatim (null-for-legacy). Deep validation lives in engine/sceneLighting.ts.

/** Where a light's transform is resolved: fixed in the scene, riding the camera, or orbiting the camera's target. Camera/subject spaces resolve per render target at the compositor seam (transition frames use different cameras for A and B). */
export type LightSpace = "world" | "camera" | "subject";

/** Dual placement, losslessly convertible (engine/orbit.ts); `mode` records whichever the user last edited. Orbit placement uses the light's own distance, never the legacy LIGHT_RADIUS. */
export type Placement =
  | { mode: "orbit"; azimuthDeg: number; elevationDeg: number; distance: number }
  | { mode: "point"; position: [number, number, number] };

/** Environment reflections for the lighting block: same shape as `ThemeEnvironment` plus the explicit `"none"` source ("no reflections", distinct from absent = inherit the layer below). Lighting only; never a visible background. */
export interface EnvironmentSpec {
  /** `"kookaburra:<slug>"` | `"kookaburra:softbox"` | a project-relative `.hdr`/`.exr` path | `"none"`. */
  source: string;
  intensity: number;
  rotationDeg: number;
}

/** The promoted key light. `azimuthDeg`/`elevationDeg`/`intensity`/`color` are byte-compatible with `ThemeLightSpec`, so a v8 `key` block parses straight in. */
export interface SunSpec {
  azimuthDeg: number;
  elevationDeg: number;
  intensity: number;
  /** 1000..20000. Wins over `colorToken` and `color` when present. */
  kelvin?: number;
  /** Theme colour token name, resolved against the active theme at render time. */
  colorToken?: string;
  /** sRGB hex. Kept for v8 compatibility. */
  color?: string;
  /** Apparent angular diameter in degrees. Real sun is 0.53. Drives shadow softness. */
  angularDeg?: number;
  /** Default true. */
  castShadow?: boolean;
  /** Default true. False keeps the entry for keyframing without lighting anything. */
  enabled?: boolean;
}

interface LightBase {
  id: string;
  name?: string;
  /** Default true. */
  enabled?: boolean;
  /** Default "world". */
  space?: LightSpace;
  intensity: number;
  /** 1000..20000. Wins over `colorToken` and `color` when present. */
  kelvin?: number;
  /** Theme colour token name, used when `kelvin` is absent. */
  colorToken?: string;
  color?: string;
  /** Default false. Rejected at parse for point (cube-map cost) and area (three.js cannot). */
  castShadow?: boolean;
  placement: Placement;
  /** Aim point in the light's own space. Default [0,0,0]. Ignored by point lights. */
  target?: [number, number, number];
}

/** One free light. `angleDeg` is the FULL cone in degrees (three's `angle` is radian half-angle); `distance`/`decay` default to three's own defaults (0 and 2). */
export type LightSpec =
  | (LightBase & { type: "directional" })
  | (LightBase & { type: "point"; distance?: number; decay?: number })
  | (LightBase & {
      type: "spot";
      angleDeg: number;
      penumbra: number;
      distance?: number;
      decay?: number;
    })
  | (LightBase & { type: "area"; width: number; height: number });

/** Bare emissive forms plus the housed practicals (v9 · PR 10: the same emissive-core-plus-paired-light anatomy wrapped in simple procedural housing geometry; no licensed assets). */
export type FixtureForm =
  | "tube"
  | "panel"
  | "ring"
  | "strip"
  | "bulb"
  | "neon-sign"
  | "tube-stand"
  | "ring-light"
  | "led-strip";

/** Neon-sign tube paths (free-form paths are out of scope by design). */
export type NeonShape = "line" | "circle" | "rect";

/** Repeat expansion for a fixture: `count` instances spaced along `axis`, optionally mirrored across `mirrorAxis`; `jitter` (0..1) varies per instance, seeded from the fixture id (engine/rng.ts, never Math.random). */
export interface FixtureRepeat {
  /** 1..FIXTURE_MAX_COUNT. */
  count: number;
  spacing: number;
  axis: "x" | "y" | "z";
  /** Duplicate the whole run mirrored across this axis. */
  mirrorAxis?: "x" | "y" | "z";
  /** 0..1 per-instance variation, seeded from the fixture id. */
  jitter?: number;
}

/** An emissive light fixture: visible geometry (`emissive` above 1.0 crosses the bloom threshold) plus a paired real light (`lightIntensity: 0` = purely decorative). */
export interface FixtureSpec {
  id: string;
  form: FixtureForm;
  name?: string;
  enabled?: boolean;
  /** Default "world". */
  space?: LightSpace;
  /** Visible geometry, world units. tube: [length, diameter]. panel: [w, h]. ring: [outerDiameter, thickness]. strip: [length, width]. bulb: [diameter, -]. */
  size: [number, number];
  kelvin?: number;
  colorToken?: string;
  color?: string;
  /** Emissive multiplier. Above 1.0 to cross the bloom threshold. */
  emissive: number;
  /** The paired real light. 0 means purely decorative geometry. */
  lightIntensity: number;
  /** Also bake this fixture into the scene environment for crisp reflections on glossy surfaces. World-space static poses only. */
  envMirror?: boolean;
  /** neon-sign only: the tube's built-in path (default "line"). */
  shape?: NeonShape;
  placement: Placement;
  rotationDeg?: [number, number, number];
  repeat?: FixtureRepeat;
}

/** One sparse keyframe pose over the WHOLE rig (one track per scene, the camera precedent): absent fields leave the base value alone, so a key that only sets `sun.intensity` touches nothing else. Colours interpolate through Kelvin when both endpoints define it (a Kelvin ramp reads as a light warming; an RGB lerp between blackbody colours goes muddy). */
export interface LightingPose {
  ambient?: number;
  environmentIntensity?: number;
  environmentRotationDeg?: number;
  sun?: { azimuthDeg?: number; elevationDeg?: number; intensity?: number; kelvin?: number };
  /** By light id. Camera/subject placements resolve per render target at the compositor seam. */
  lights?: Record<string, { intensity?: number; kelvin?: number; placement?: Placement }>;
  /** By fixture id. */
  fixtures?: Record<string, { emissive?: number; lightIntensity?: number; placement?: Placement }>;
}

export interface LightingKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: LightingPose;
}

export interface LightingSegment {
  from: string;
  to: string;
  /** An engine/ease.ts name. */
  ease: string;
}

/** v9 lighting. Absent at every layer resolves to the v8 path verbatim. `key` is accepted as an alias for `sun` on read and normalised to `sun` in memory; nothing rewrites theme files. */
export interface LightingSpec {
  environment?: EnvironmentSpec;
  sun?: SunSpec;
  ambient?: number;
  /** Ambient-light tint; absent remains white. */
  ambientColor?: string;
  /** Legacy v8 fills, kept so existing themes parse unchanged. New work uses `lights`. */
  fills?: ThemeLightSpec[];
  lights?: LightSpec[];
  fixtures?: FixtureSpec[];
  shadow?: ThemeShadowSpec;
  /** Bundled preset id last applied by the picker. The renderer never reads it. */
  preset?: string;
  /** False mutes the scene track without deleting keys or segments. */
  animationEnabled?: boolean;
  /** The scene's lighting keyframe track (SCENE-DOC layer only; themes and project defaults never animate). Raw here like the camera's sidecar block; deep validation lives in `normalizeLightingTrack`. */
  keys?: LightingKey[];
  segments?: LightingSegment[];
}

/** Environment reflections (IBL), the v8 theme block: `source` is a bundled HDRI id (`kookaburra:<name>`) or the Lightformer preset id (`kookaburra:softbox`). Project-relative `.hdr`/`.exr` sources and the explicit `"none"` live on the v9 `LightingSpec.environment` (same shape, wider vocabulary). Preloaded before frame 0 via `preloadEnvironments`. */
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
  /** A looping video fill riding the clip frame pipeline. SCENE-DOC ONLY (decision 5: themes are workspace-shared and can't reference project assets; the theme parser drops it). Absent `loop` = true; `loop: false` holds the last frame. Absent `fit` = `fill` (cover-crop to fill the frame); `fit` letterboxes the whole video with bars in the theme background colour. */
  | { type: "video"; src: string; parallax?: number; loop?: boolean; fit?: "fill" | "fit" }
  /** A world-space animated 3D background (SCENE3D_BACKGROUNDS): real geometry mounted in the scene, so it parallaxes with camera rigs, staged outside the content volume with a keep-out clearance and distance fades. `backing` nests any camera-locked 2D background behind the geometry (another scene3d is rejected by the parser). Theme-safe (no asset references). */
  | {
      type: "scene3d";
      look: string;
      colors?: string[];
      /** Live Theme preset: derive geometry colours from the active theme at resolve time (scene3d/Scene3dBackdrop.tsx); while set, explicit `colors` are ignored. */
      themeColors?: boolean;
      speed?: number;
      params?: Record<string, number>;
      backing?: ThemeBackground;
      /** Bundled preset id last applied by the picker; the renderer never reads it, only the inspector's Reset and tile highlight do. */
      preset?: string;
    }
  /** An animated GLSL fill (the vendored paper-design pack): `shader` names a SHADER_BACKGROUNDS id, `colors` are hexes filling the effect's slots, `speed` multiplies the ABSOLUTE project clock (continuous across scene cuts), `params` are the effect's own numeric knobs. Theme-safe (no asset references). */
  | {
      type: "shader";
      shader: string;
      colors?: string[];
      /** Live Theme preset: derive slot colours from the active theme's tokens at resolve time (shaders/themePreset.ts); while set, explicit `colors` are ignored and the fill follows theme switches. */
      themeColors?: boolean;
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
  /** Optional in/out window length. Absent keeps each primitive's authored timing. */
  durationMs?: number;
  /** Optional preset travel distance in em. Absent keeps each preset's tuned distance. */
  distance?: number;
  /** An engine/ease.ts name. Absent keeps the theme's standard easing. */
  ease?: string;
}

/** Card surfaces (layered-screenshot screens): corner radius as a fraction of the card's short edge, clamped 0..0.5 at parse. Absent themes take the toolkit's tuned constant. */
export interface ThemeCard {
  radius: number;
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
  /** Chart series swatches (sRGB hexes, six in the bundled themes), taken in order and wrapped when a chart has more series. Optional and additive: a theme without it derives its ramp from `accent` instead (toolkit/chart/palette.ts), and parses exactly as before. */
  chartColors?: string[];
  typography: {
    headline: FontRef;
    body: FontRef;
    /** Modular scale ratio between type steps. */
    scale: number;
    /** One face for ALL chart text, replacing both of the above there. Injected by the project's `typography.chart` override (`engine/project.ts`), never parsed from theme.json; absent means charts take headline/body as before. */
    chart?: FontRef;
  };
  motion: {
    /** Milliseconds. */
    durations: { fast: number; base: number; slow: number };
    /** anime.js / d3-ease easing names. */
    easings: { standard: string; emphasized: string };
  };
  textAnimation?: TextAnimationSpec;
  card?: ThemeCard;
  /** v9 shape in memory (the v8 `key` alias normalises to `sun` on read); theme JSON files stay v8. */
  lighting?: LightingSpec;
  environment?: ThemeEnvironment;
  backdrop?: ThemeBackdrop;
  background?: ThemeBackground;
  /** Project-wide postprocessing defaults; optional and absent by default. A theme without `effects` renders through the original composer-free path, preserving the v0-v2 byte-identical export. Per-scene overrides layer on top via `resolveEffectParams`. */
  effects?: EffectsConfig;
}
