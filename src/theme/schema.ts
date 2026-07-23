import type {
  EffectsConfig,
  FontRef,
  GradientSpec,
  TextAnimationSpec,
  Theme,
  ThemeBackdrop,
  ThemeBackground,
  ThemeEnvironment,
  ThemeLighting,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "./tokens";

/** The theme document schema: `theme.json`, one format for bundled and user themes, parsed with the same degrade-don't-crash contract as `parseSceneDoc` - a malformed OPTIONAL block drops with a warning, a malformed REQUIRED block (colors/typography/motion) rejects the whole document so a bad theme file never tears down the canvas tree. Unknown fields are ignored. PURE module (types + validation only); IO lives in `theme/registry.ts`. See docs/decisions.md ("Themes & typography"). */

/** Newest theme schema this build understands (newer docs are ignored with a warning). */
export const THEME_DOC_VERSION = 2;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** `typography.headline`/`body` accept a plain family (weight 400) or `{family, weight}`. */
function parseFontRef(v: unknown): FontRef | undefined {
  if (isStr(v)) return { family: v, weight: 400 };
  if (isRecord(v) && isStr(v.family)) {
    return { family: v.family, weight: isNum(v.weight) ? v.weight : 400 };
  }
  return undefined;
}

function parseLightSpec(v: unknown): ThemeLightSpec | undefined {
  if (!isRecord(v)) return undefined;
  if (!isNum(v.azimuthDeg) || !isNum(v.elevationDeg) || !isNum(v.intensity)) return undefined;
  const light: ThemeLightSpec = {
    azimuthDeg: v.azimuthDeg,
    elevationDeg: v.elevationDeg,
    intensity: v.intensity,
  };
  if (isStr(v.color)) light.color = v.color;
  return light;
}

function parseShadow(v: unknown): ThemeShadowSpec | undefined {
  if (!isRecord(v)) return undefined;
  if (v.technique !== "map" && v.technique !== "none") return undefined;
  if (!isNum(v.softness) || !isNum(v.opacity) || !isNum(v.mapSize) || !isNum(v.bias)) {
    return undefined;
  }
  const shadow: ThemeShadowSpec = {
    technique: v.technique,
    softness: v.softness,
    opacity: v.opacity,
    mapSize: v.mapSize,
    bias: v.bias,
  };
  if (isStr(v.color)) shadow.color = v.color;
  return shadow;
}

function parseLighting(v: unknown, source: string): ThemeLighting | undefined {
  if (!isRecord(v)) return undefined;
  const key = parseLightSpec(v.key);
  if (!key || !isNum(v.ambient)) {
    console.warn(`[theme] ${source}: "lighting" needs a valid key light + ambient — dropped`);
    return undefined;
  }
  const fills: ThemeLightSpec[] = [];
  if (Array.isArray(v.fills)) {
    for (const f of v.fills) {
      const fill = parseLightSpec(f);
      if (fill) fills.push(fill);
      else console.warn(`[theme] ${source}: invalid fill light — dropped`);
    }
  }
  const lighting: ThemeLighting = { key, fills, ambient: v.ambient };
  if (v.shadow !== undefined) {
    const shadow = parseShadow(v.shadow);
    if (shadow) lighting.shadow = shadow;
    else console.warn(`[theme] ${source}: invalid "lighting.shadow" — dropped`);
  }
  return lighting;
}

function parseEnvironment(v: unknown, source: string): ThemeEnvironment | undefined {
  if (!isRecord(v) || !isStr(v.source)) {
    console.warn(`[theme] ${source}: "environment" needs a string source — dropped`);
    return undefined;
  }
  return {
    source: v.source,
    intensity: isNum(v.intensity) ? v.intensity : 1,
    rotationDeg: isNum(v.rotationDeg) ? v.rotationDeg : 0,
  };
}

/** Exported: the background's inline gradient spec reuses this validator. */
export function parseGradient(v: unknown): GradientSpec | undefined {
  if (!isRecord(v)) return undefined;
  if (v.type !== "linear" && v.type !== "radial") return undefined;
  if (!isNum(v.angleDeg) || !Array.isArray(v.stops)) return undefined;
  const stops: [string, number][] = [];
  for (const s of v.stops) {
    if (Array.isArray(s) && isStr(s[0]) && isNum(s[1])) stops.push([s[0], s[1]]);
    else return undefined;
  }
  if (stops.length < 2) return undefined;
  const gradient: GradientSpec = { type: v.type, angleDeg: v.angleDeg, stops };
  if (v.space === "oklch") gradient.space = "oklch";
  return gradient;
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
      if (name) return { type: "gradient", gradient: name };
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
  console.warn(`[theme] ${source}: invalid "backdrop" — dropped`);
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
  const withParallax = <T extends Exclude<ThemeBackground, { type: "none" }>>(out: T): T => {
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
      if (name) return withParallax({ type: "gradient", gradient: name });
      break;
    }
    case "image":
      if (isStr(v.src)) return withParallax({ type: "image", src: v.src });
      break;
    case "video":
      if (!opts.video) {
        console.warn(`[theme] ${source}: video backgrounds are scene-doc only — dropped`);
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
  console.warn(`[theme] ${source}: invalid "background" — dropped`);
  return undefined;
}

/** A PARTIAL lighting override (scene docs): each present field fully replaces the theme's (no deep merge of `key` etc. - predictable over clever). Exported for the sidecar schema; returns undefined when nothing valid survives. */
export function parseLightingOverride(
  v: unknown,
  source: string,
): Partial<ThemeLighting> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Partial<ThemeLighting> = {};
  if (v.key !== undefined) {
    const key = parseLightSpec(v.key);
    if (key) out.key = key;
    else console.warn(`[theme] ${source}: invalid lighting override "key" — dropped`);
  }
  if (Array.isArray(v.fills)) {
    const fills: ThemeLightSpec[] = [];
    for (const f of v.fills) {
      const fill = parseLightSpec(f);
      if (fill) fills.push(fill);
      else console.warn(`[theme] ${source}: invalid lighting override fill — dropped`);
    }
    out.fills = fills;
  }
  if (isNum(v.ambient)) out.ambient = v.ambient;
  if (v.shadow !== undefined) {
    const shadow = parseShadow(v.shadow);
    if (shadow) out.shadow = shadow;
    else console.warn(`[theme] ${source}: invalid lighting override "shadow" — dropped`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merges a scene doc's partial lighting override onto the theme's lighting (field-level full replacement). Without a base, an override applies only when complete enough to light a scene (key + ambient). */
export function mergeLighting(
  base: ThemeLighting | undefined,
  override: Partial<ThemeLighting> | undefined,
): ThemeLighting | undefined {
  if (!override) return base;
  if (base) {
    const merged: ThemeLighting = {
      key: override.key ?? base.key,
      fills: override.fills ?? base.fills,
      ambient: override.ambient ?? base.ambient,
    };
    const shadow = override.shadow ?? base.shadow;
    if (shadow) merged.shadow = shadow;
    return merged;
  }
  if (override.key && override.ambient !== undefined) {
    const built: ThemeLighting = {
      key: override.key,
      fills: override.fills ?? [],
      ambient: override.ambient,
    };
    if (override.shadow) built.shadow = override.shadow;
    return built;
  }
  return undefined;
}

/** Text-animation spec parser, exported for the sidecar's whole-spec `textAnimation` override. Preset NAMES stay raw strings (validated later by `coercePreset` at resolve); other params validate per-field, drop-and-warn. */
export function parseTextAnimationSpec(v: unknown, source: string): TextAnimationSpec | undefined {
  if (!isRecord(v) || !isStr(v.in) || !isStr(v.out)) {
    console.warn(`[theme] ${source}: "textAnimation" needs "in" + "out" preset names — dropped`);
    return undefined;
  }
  const spec: TextAnimationSpec = {
    in: v.in,
    out: v.out,
    staggerMs: isNum(v.staggerMs) ? v.staggerMs : 0,
  };
  if (v.stagger === "char" || v.stagger === "word") spec.stagger = v.stagger;
  if (isNum(v.startScale)) spec.startScale = v.startScale;
  else if (v.startScale !== undefined) {
    console.warn(`[theme] ${source}: invalid "textAnimation.startScale" — dropped`);
  }
  if (typeof v.shine === "boolean") spec.shine = v.shine;
  else if (v.shine !== undefined) {
    console.warn(`[theme] ${source}: invalid "textAnimation.shine" — dropped`);
  }
  if (v.direction === "from-left" || v.direction === "from-right") spec.direction = v.direction;
  else if (v.direction !== undefined) {
    console.warn(`[theme] ${source}: invalid "textAnimation.direction" — dropped`);
  }
  if (
    v.delivery === "all-at-once" ||
    v.delivery === "by-paragraph" ||
    v.delivery === "by-paragraph-group"
  ) {
    spec.delivery = v.delivery;
  } else if (v.delivery !== undefined) {
    console.warn(`[theme] ${source}: invalid "textAnimation.delivery" — dropped`);
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
  } else if (b !== undefined) console.warn(`[theme] ${source}: invalid "effects.bloom" — dropped`);
  const g = v.vignette;
  if (isRecord(g) && isNum(g.offset) && isNum(g.darkness)) {
    out.vignette = { offset: g.offset, darkness: g.darkness };
  } else if (g !== undefined) {
    console.warn(`[theme] ${source}: invalid "effects.vignette" — dropped`);
  }
  const l = v.lut;
  if (isRecord(l) && isStr(l.url) && isNum(l.intensity)) {
    out.lut = { url: l.url, intensity: l.intensity };
  } else if (l !== undefined) console.warn(`[theme] ${source}: invalid "effects.lut" — dropped`);
  const n = v.grain;
  if (isRecord(n) && isNum(n.intensity)) {
    out.grain = { intensity: n.intensity };
  } else if (n !== undefined) console.warn(`[theme] ${source}: invalid "effects.grain" — dropped`);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validates a raw theme document into a resolved `Theme`. Returns `undefined` (with a console warning) rather than throwing; callers fall back to the default theme. */
export function parseThemeDoc(raw: unknown, source: string): Theme | undefined {
  if (!isRecord(raw)) {
    console.warn(`[theme] ${source}: not an object — ignored`);
    return undefined;
  }
  if (!isNum(raw.version) || raw.version < 1) {
    console.warn(`[theme] ${source}: missing/invalid "version" — ignored`);
    return undefined;
  }
  if (raw.version > THEME_DOC_VERSION) {
    console.warn(
      `[theme] ${source}: version ${raw.version} is newer than this Kookaburra Cut understands — ignored`,
    );
    return undefined;
  }
  if (!isStr(raw.id)) {
    console.warn(`[theme] ${source}: missing/invalid "id" — ignored`);
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
    console.warn(`[theme] ${source}: "colors" needs background/text/accent/muted — ignored`);
    return undefined;
  }

  const typography = raw.typography;
  const headline = isRecord(typography) ? parseFontRef(typography.headline) : undefined;
  const body = isRecord(typography) ? parseFontRef(typography.body) : undefined;
  if (!isRecord(typography) || !headline || !body || !isNum(typography.scale)) {
    console.warn(`[theme] ${source}: "typography" needs headline/body/scale — ignored`);
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
    console.warn(`[theme] ${source}: "motion" needs durations + easings — ignored`);
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
      const gradient = parseGradient(value);
      if (gradient) gradients[name] = gradient;
      else console.warn(`[theme] ${source}: gradient "${name}" is invalid — dropped`);
    }
    if (Object.keys(gradients).length > 0) theme.gradients = gradients;
  }

  if (raw.textAnimation !== undefined) {
    const textAnimation = parseTextAnimationSpec(raw.textAnimation, source);
    if (textAnimation) theme.textAnimation = textAnimation;
  }
  if (raw.card !== undefined) {
    const card = raw.card;
    if (isRecord(card) && isNum(card.radius) && card.radius >= 0 && card.radius <= 0.5) {
      theme.card = { radius: card.radius };
    } else {
      console.warn(`[theme] ${source}: invalid "card", dropped`);
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
