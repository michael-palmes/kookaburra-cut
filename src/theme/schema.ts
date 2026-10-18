import { parseMotionBlurOverride } from "../engine/motionBlur";
import { parseWarn } from "../engine/parseWarnings";
import { normalizeLighting, resolveLighting } from "../engine/sceneLighting";
import { parseFontString } from "./fontRef";
import type {
  EffectsConfig,
  FontRef,
  GradientSpec,
  LightingSpec,
  TextAnimationSpec,
  TextLookSpec,
  Theme,
  ThemeBackdrop,
  ThemeBackground,
  ThemeEnvironment,
} from "./tokens";

/** The theme document schema: `theme.json`, one format for bundled and user themes, parsed with the same degrade-don't-crash contract as `parseSceneDoc` - a malformed OPTIONAL block drops with a warning, a malformed REQUIRED block (colors/typography/motion) rejects the whole document so a bad theme file never tears down the canvas tree. Unknown fields are ignored. PURE module (types + validation only); IO lives in `theme/registry.ts`. See docs/decisions.md ("Themes & typography"). */

/** Newest theme schema this build understands (newer docs are ignored with a warning). */
export const THEME_DOC_VERSION = 3;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** `typography.headline`/`body` accept a font string (`"Family"` or `"Family@weight"`, the sidecar grammar) or `{family, weight}`. */
function parseFontRef(v: unknown): FontRef | undefined {
  if (isStr(v)) return parseFontString(v);
  if (isRecord(v) && isStr(v.family)) {
    return { family: v.family, weight: isNum(v.weight) ? v.weight : 400 };
  }
  return undefined;
}

/** Theme lighting parses through the v9 module (engine/sceneLighting.ts): the v8 `key` alias normalises to `sun` in memory, and the theme-layer gate keeps the v8 contract (a block with no renderable rig drops whole). Nothing rewrites theme files. */
function parseLighting(v: unknown, source: string): LightingSpec | undefined {
  return normalizeLighting(v, source, { themeLayer: true }) ?? undefined;
}

function parseEnvironment(v: unknown, source: string): ThemeEnvironment | undefined {
  if (!isRecord(v) || !isStr(v.source)) {
    parseWarn(`[theme] ${source}: "environment" needs a string source, dropped`);
    return undefined;
  }
  return {
    source: v.source,
    intensity: isNum(v.intensity) ? v.intensity : 1,
    rotationDeg: isNum(v.rotationDeg) ? v.rotationDeg : 0,
  };
}

/** Exported: the background's inline gradient spec reuses this validator. A radial gradient may omit `angleDeg` (0); a linear one may not. With a `source` the reason a spec drops is warned. */
export function parseGradient(
  v: unknown,
  source?: string,
  label = "gradient",
): GradientSpec | undefined {
  const drop = (why: string): undefined => {
    if (source) parseWarn(`[theme] ${source}: ${label} ${why}, dropped`);
    return undefined;
  };
  if (!isRecord(v)) return drop("isn't an object");
  if (v.type !== "linear" && v.type !== "radial") return drop('needs a "type" of linear or radial');
  let angleDeg: number;
  if (isNum(v.angleDeg)) angleDeg = v.angleDeg;
  else if (v.type === "radial" && v.angleDeg === undefined) angleDeg = 0;
  else return drop('needs a numeric "angleDeg"');
  if (!Array.isArray(v.stops)) return drop('needs a "stops" list');
  const stops: [string, number][] = [];
  for (const s of v.stops) {
    if (Array.isArray(s) && isStr(s[0]) && isNum(s[1])) stops.push([s[0], s[1]]);
    else return drop('has a stop that isn\'t ["colour", position]');
  }
  if (stops.length < 2) return drop("needs at least two stops");
  const gradient: GradientSpec = { type: v.type, angleDeg, stops };
  if (v.space === "oklch") gradient.space = "oklch";
  return gradient;
}

/** A named gradient standing in for an inline spec that failed: the reference still renders, but not as written. */
function warnInlineFallback(source: string, key: string, name: string): void {
  parseWarn(
    `[theme] ${source}: "${key}.spec" isn't a valid gradient, so the "${name}" gradient shows instead`,
  );
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Chart series swatches: hex strings only, a malformed entry dropping alone (the palette then wraps over the survivors). Nothing valid leaves the theme without the field, so the derived accent ramp applies. */
function parseChartColors(v: unknown, source: string): string[] | undefined {
  if (!Array.isArray(v)) {
    parseWarn(`[theme] ${source}: "chartColors" isn't an array, dropped`);
    return undefined;
  }
  const colors: string[] = [];
  for (const entry of v) {
    if (isStr(entry) && HEX_COLOR.test(entry)) colors.push(entry);
    else parseWarn(`[theme] ${source}: a "chartColors" entry isn't a hex colour, dropped`);
  }
  return colors.length > 0 ? colors : undefined;
}

/** Backdrop parser, exported for reuse by the sidecar schema (a scene doc may override its theme's backdrop). Same degrade semantics. */
export function parseBackdropSpec(v: unknown, source: string): ThemeBackdrop | undefined {
  if (!isRecord(v)) return undefined;
  switch (v.type) {
    case "none":
      return { type: "none" };
    case "floor": {
      if (!isStr(v.color)) break;
      const floor: Extract<ThemeBackdrop, { type: "floor" }> = { type: "floor", color: v.color };
      if (isNum(v.filletRadius)) floor.filletRadius = v.filletRadius;
      return floor;
    }
    case "gradient": {
      const name = isStr(v.gradient) ? v.gradient : undefined;
      const inline = v.spec !== undefined ? parseGradient(v.spec) : undefined;
      if (inline) {
        const out: Extract<ThemeBackdrop, { type: "gradient" }> = {
          type: "gradient",
          spec: inline,
        };
        if (name) out.gradient = name;
        return out;
      }
      if (name) {
        if (v.spec !== undefined) warnInlineFallback(source, "backdrop", name);
        return { type: "gradient", gradient: name };
      }
      break;
    }
    case "image":
      if (isStr(v.src)) {
        return {
          type: "image",
          src: v.src,
          fit: v.fit === "contain" ? "contain" : "cover",
        };
      }
      break;
  }
  parseWarn(`[theme] ${source}: invalid "backdrop", dropped`);
  return undefined;
}

/** Fixed-background parser, exported for reuse by the sidecar schema (a scene doc may override its theme's camera-locked background). Same degrade semantics as `parseBackdropSpec`. `parallax` clamps to [0, 0.5]; non-numeric omits it (renders hard-locked). */
export function parseBackgroundSpec(
  v: unknown,
  source: string,
  opts: {
    /** Video fills are SCENE-DOC only (decision 5: themes are workspace-shared and can't reference project assets). Only the sidecar parser passes true. */
    video?: boolean;
  } = {},
): ThemeBackground | undefined {
  if (!isRecord(v)) return undefined;
  const parallax = isNum(v.parallax) ? Math.min(0.5, Math.max(0, v.parallax)) : undefined;
  const withParallax = <T extends Exclude<ThemeBackground, { type: "none" } | { type: "scene3d" }>>(
    out: T,
  ): T => {
    if (parallax !== undefined) out.parallax = parallax;
    return out;
  };
  switch (v.type) {
    case "none":
      return { type: "none" };
    case "color":
      if (isStr(v.color)) return withParallax({ type: "color", color: v.color });
      break;
    case "gradient": {
      const name = isStr(v.gradient) ? v.gradient : undefined;
      const inline = v.spec !== undefined ? parseGradient(v.spec) : undefined;
      if (inline) {
        const out: Extract<ThemeBackground, { type: "gradient" }> = {
          type: "gradient",
          spec: inline,
        };
        if (name) out.gradient = name;
        return withParallax(out);
      }
      if (name) {
        if (v.spec !== undefined) warnInlineFallback(source, "background", name);
        return withParallax({ type: "gradient", gradient: name });
      }
      break;
    }
    case "image":
      if (isStr(v.src)) return withParallax({ type: "image", src: v.src });
      break;
    case "video":
      if (!opts.video) {
        parseWarn(`[theme] ${source}: video backgrounds are scene-doc only, dropped`);
        return undefined;
      }
      if (isStr(v.src)) {
        const out: Extract<ThemeBackground, { type: "video" }> = { type: "video", src: v.src };
        // Only `false` is stored; absent = loop (decision 6, one knob).
        if (v.loop === false) out.loop = false;
        // Only `fit` is stored; absent = fill (cover-crop, the byte-identical legacy path).
        if (v.fit === "fit") out.fit = "fit";
        return withParallax(out);
      }
      break;
    case "scene3d": {
      if (!isStr(v.look)) break;
      // Schema-light like the shader case; no parallax (world geometry parallaxes via the camera itself).
      const out: Extract<ThemeBackground, { type: "scene3d" }> = {
        type: "scene3d",
        look: v.look,
      };
      if (Array.isArray(v.colors)) {
        const colors = (v.colors as unknown[]).filter(isStr);
        if (colors.length > 0) out.colors = colors;
      }
      if (v.themeColors === true) out.themeColors = true;
      if (isNum(v.speed)) out.speed = Math.min(4, Math.max(0, v.speed));
      if (isRecord(v.params)) {
        const params: Record<string, number> = {};
        for (const [key, value] of Object.entries(v.params)) {
          if (isNum(value)) params[key] = value;
        }
        if (Object.keys(params).length > 0) out.params = params;
      }
      // One nesting level only: a scene3d backing inside a scene3d drops the backing.
      if (isRecord(v.backing) && v.backing.type !== "scene3d") {
        const backing = parseBackgroundSpec(v.backing, `${source} backing`, opts);
        if (backing) out.backing = backing;
      }
      if (isStr(v.preset)) out.preset = v.preset;
      return out;
    }
    case "shader": {
      if (!isStr(v.shader)) break;
      // Schema-light like transitions: the renderer degrades unknown ids/params, the parser only pins the shape.
      const out: Extract<ThemeBackground, { type: "shader" }> = {
        type: "shader",
        shader: v.shader,
      };
      if (Array.isArray(v.colors)) {
        const colors = (v.colors as unknown[]).filter(isStr);
        if (colors.length > 0) out.colors = colors;
      }
      // Only `true` is stored; the renderer derives the colours from the active theme.
      if (v.themeColors === true) out.themeColors = true;
      if (isNum(v.speed)) out.speed = Math.min(4, Math.max(0, v.speed));
      if (isNum(v.scale)) out.scale = Math.min(4, Math.max(0.1, v.scale));
      if (isRecord(v.params)) {
        const params: Record<string, number> = {};
        for (const [key, value] of Object.entries(v.params)) {
          if (isNum(value)) params[key] = value;
        }
        if (Object.keys(params).length > 0) out.params = params;
      }
      if (isStr(v.preset)) out.preset = v.preset;
      return withParallax(out);
    }
  }
  parseWarn(`[theme] ${source}: invalid "background", dropped`);
  return undefined;
}

/** A PARTIAL lighting override (scene docs): each present field fully replaces the layer below's (no deep merge - predictable over clever). Exported for the sidecar schema; returns undefined when nothing valid survives. */
export function parseLightingOverride(v: unknown, source: string): LightingSpec | undefined {
  return normalizeLighting(v, source) ?? undefined;
}

/** Merges the three lighting layers (theme -> project -> scene), field-level full replacement. Without any renderable rig (sun + ambient, or v9 lights/fixtures) the result is undefined: the pre-v9 code path verbatim. */
export function mergeLighting(
  theme: LightingSpec | undefined,
  project: LightingSpec | undefined,
  scene: LightingSpec | undefined,
): LightingSpec | undefined {
  return resolveLighting(theme, project, scene);
}

/** Text-animation spec parser, exported for the sidecar's whole-spec `textAnimation` override. Preset NAMES stay raw strings (validated later by `coercePreset` at resolve); other params validate per-field, drop-and-warn. */
export function parseTextAnimationSpec(v: unknown, source: string): TextAnimationSpec | undefined {
  if (!isRecord(v) || !isStr(v.in) || !isStr(v.out)) {
    parseWarn(`[theme] ${source}: "textAnimation" needs "in" + "out" preset names, dropped`);
    return undefined;
  }
  const spec: TextAnimationSpec = {
    in: v.in,
    out: v.out,
    staggerMs: isNum(v.staggerMs) ? v.staggerMs : 0,
  };
  if (v.stagger === "char" || v.stagger === "word") spec.stagger = v.stagger;
  if (isNum(v.delayMs)) spec.delayMs = v.delayMs;
  else if (v.delayMs !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.delayMs", dropped`);
  }
  if (isNum(v.startScale)) spec.startScale = v.startScale;
  else if (v.startScale !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.startScale", dropped`);
  }
  if (typeof v.shine === "boolean") spec.shine = v.shine;
  else if (v.shine !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.shine", dropped`);
  }
  if (v.direction === "from-left" || v.direction === "from-right") spec.direction = v.direction;
  else if (v.direction !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.direction", dropped`);
  }
  if (
    v.delivery === "all-at-once" ||
    v.delivery === "by-paragraph" ||
    v.delivery === "by-paragraph-group"
  ) {
    spec.delivery = v.delivery;
  } else if (v.delivery !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.delivery", dropped`);
  }
  if (isNum(v.durationMs) && v.durationMs > 0) spec.durationMs = v.durationMs;
  else if (v.durationMs !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.durationMs", dropped`);
  }
  if (isNum(v.distance) && v.distance >= 0) spec.distance = v.distance;
  else if (v.distance !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.distance", dropped`);
  }
  if (isStr(v.ease)) spec.ease = v.ease;
  else if (v.ease !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textAnimation.ease", dropped`);
  }
  const motionBlur = parseMotionBlurOverride(v.motionBlur, `${source} textAnimation`);
  if (motionBlur) spec.motionBlur = motionBlur;
  return spec;
}

/** Text-look spec parser, exported for the sidecar's whole-spec `textLook` override. The preset NAME stays a raw string (validated later by `coerceLook` at resolve); params validate per-field, drop-and-warn, with range clamping left to resolve (the startScale pattern). */
export function parseTextLookSpec(v: unknown, source: string): TextLookSpec | undefined {
  if (!isRecord(v) || !isStr(v.preset)) {
    parseWarn(`[theme] ${source}: "textLook" needs a "preset" name, dropped`);
    return undefined;
  }
  const spec: TextLookSpec = { preset: v.preset };
  if (isStr(v.colorA)) spec.colorA = v.colorA;
  else if (v.colorA !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.colorA", dropped`);
  }
  if (isStr(v.colorB)) spec.colorB = v.colorB;
  else if (v.colorB !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.colorB", dropped`);
  }
  if (isNum(v.angleDeg)) spec.angleDeg = v.angleDeg;
  else if (v.angleDeg !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.angleDeg", dropped`);
  }
  if (isNum(v.strokeEm)) spec.strokeEm = v.strokeEm;
  else if (v.strokeEm !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.strokeEm", dropped`);
  }
  if (typeof v.hollow === "boolean") spec.hollow = v.hollow;
  else if (v.hollow !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.hollow", dropped`);
  }
  if (isNum(v.intensity)) spec.intensity = v.intensity;
  else if (v.intensity !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.intensity", dropped`);
  }
  if (isNum(v.offsetEm)) spec.offsetEm = v.offsetEm;
  else if (v.offsetEm !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.offsetEm", dropped`);
  }
  if (isNum(v.curveDeg)) spec.curveDeg = v.curveDeg;
  else if (v.curveDeg !== undefined) {
    parseWarn(`[theme] ${source}: invalid "textLook.curveDeg", dropped`);
  }
  return spec;
}

/** Validate one effect block; wrong-typed fields drop the single effect, not the stack. */
function parseEffects(v: unknown, source: string): EffectsConfig | undefined {
  if (!isRecord(v)) return undefined;
  const out: EffectsConfig = {};
  const b = v.bloom;
  if (
    isRecord(b) &&
    isNum(b.intensity) &&
    isNum(b.luminanceThreshold) &&
    isNum(b.luminanceSmoothing)
  ) {
    out.bloom = {
      intensity: b.intensity,
      luminanceThreshold: b.luminanceThreshold,
      luminanceSmoothing: b.luminanceSmoothing,
    };
  } else if (b !== undefined) parseWarn(`[theme] ${source}: invalid "effects.bloom", dropped`);
  const g = v.vignette;
  if (isRecord(g) && isNum(g.offset) && isNum(g.darkness)) {
    out.vignette = { offset: g.offset, darkness: g.darkness };
  } else if (g !== undefined) {
    parseWarn(`[theme] ${source}: invalid "effects.vignette", dropped`);
  }
  const l = v.lut;
  if (isRecord(l) && isStr(l.url) && isNum(l.intensity)) {
    out.lut = { url: l.url, intensity: l.intensity };
  } else if (l !== undefined) parseWarn(`[theme] ${source}: invalid "effects.lut", dropped`);
  const n = v.grain;
  if (isRecord(n) && isNum(n.intensity)) {
    out.grain = { intensity: n.intensity };
  } else if (n !== undefined) parseWarn(`[theme] ${source}: invalid "effects.grain", dropped`);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validates a raw theme document into a resolved `Theme`. Returns `undefined` (with a parse warning) rather than throwing; callers fall back to the default theme. */
export function parseThemeDoc(raw: unknown, source: string): Theme | undefined {
  if (!isRecord(raw)) {
    parseWarn(`[theme] ${source}: not an object, ignored`);
    return undefined;
  }
  if (!isNum(raw.version) || raw.version < 1) {
    parseWarn(`[theme] ${source}: missing/invalid "version", ignored`);
    return undefined;
  }
  if (raw.version > THEME_DOC_VERSION) {
    parseWarn(
      `[theme] ${source}: version ${raw.version} is newer than this Kookaburra Cut understands, ignored`,
    );
    return undefined;
  }
  if (!isStr(raw.id)) {
    parseWarn(`[theme] ${source}: missing/invalid "id", ignored`);
    return undefined;
  }

  const colors = raw.colors;
  if (
    !isRecord(colors) ||
    !isStr(colors.background) ||
    !isStr(colors.text) ||
    !isStr(colors.accent) ||
    !isStr(colors.muted)
  ) {
    parseWarn(`[theme] ${source}: "colors" needs background/text/accent/muted, ignored`);
    return undefined;
  }

  const typography = raw.typography;
  const headline = isRecord(typography) ? parseFontRef(typography.headline) : undefined;
  const body = isRecord(typography) ? parseFontRef(typography.body) : undefined;
  if (!isRecord(typography) || !headline || !body || !isNum(typography.scale)) {
    parseWarn(`[theme] ${source}: "typography" needs headline/body/scale, ignored`);
    return undefined;
  }

  const motion = raw.motion;
  const durations = isRecord(motion) ? motion.durations : undefined;
  const easings = isRecord(motion) ? motion.easings : undefined;
  if (
    !isRecord(durations) ||
    !isNum(durations.fast) ||
    !isNum(durations.base) ||
    !isNum(durations.slow) ||
    !isRecord(easings) ||
    !isStr(easings.standard) ||
    !isStr(easings.emphasized)
  ) {
    parseWarn(`[theme] ${source}: "motion" needs durations + easings, ignored`);
    return undefined;
  }

  const theme: Theme = {
    id: raw.id,
    name: isStr(raw.name) ? raw.name : raw.id,
    colors: {
      background: colors.background,
      text: colors.text,
      accent: colors.accent,
      muted: colors.muted,
    },
    typography: { headline, body, scale: typography.scale },
    motion: {
      durations: { fast: durations.fast, base: durations.base, slow: durations.slow },
      easings: { standard: easings.standard, emphasized: easings.emphasized },
    },
  };

  if (raw.mode === "light" || raw.mode === "dark") theme.mode = raw.mode;

  if (isRecord(raw.gradients)) {
    const gradients: Record<string, GradientSpec> = {};
    for (const [name, value] of Object.entries(raw.gradients)) {
      const gradient = parseGradient(value, source, `gradient "${name}"`);
      if (gradient) gradients[name] = gradient;
    }
    if (Object.keys(gradients).length > 0) theme.gradients = gradients;
  }

  if (raw.chartColors !== undefined) {
    const chartColors = parseChartColors(raw.chartColors, source);
    if (chartColors) theme.chartColors = chartColors;
  }

  if (raw.textAnimation !== undefined) {
    const textAnimation = parseTextAnimationSpec(raw.textAnimation, source);
    if (textAnimation) theme.textAnimation = textAnimation;
  }
  if (raw.textLook !== undefined) {
    const textLook = parseTextLookSpec(raw.textLook, source);
    if (textLook) theme.textLook = textLook;
  }
  if (raw.card !== undefined) {
    const card = raw.card;
    if (isRecord(card) && isNum(card.radius) && card.radius >= 0 && card.radius <= 0.5) {
      theme.card = { radius: card.radius };
    } else {
      parseWarn(`[theme] ${source}: invalid "card", dropped`);
    }
  }
  if (raw.lighting !== undefined) {
    const lighting = parseLighting(raw.lighting, source);
    if (lighting) theme.lighting = lighting;
  }
  if (raw.environment !== undefined) {
    const environment = parseEnvironment(raw.environment, source);
    if (environment) theme.environment = environment;
  }
  if (raw.backdrop !== undefined) {
    const backdrop = parseBackdropSpec(raw.backdrop, source);
    if (backdrop) theme.backdrop = backdrop;
  }
  if (raw.background !== undefined) {
    const background = parseBackgroundSpec(raw.background, source);
    if (background) theme.background = background;
  }
  if (raw.effects !== undefined) {
    const effects = parseEffects(raw.effects, source);
    if (effects) theme.effects = effects;
  }
  return theme;
}
