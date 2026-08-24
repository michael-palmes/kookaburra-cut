import { Text } from "@react-three/drei";
import {
  type RefObject,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Color, type Object3D } from "three";
import { registerGizmoTarget, unregisterGizmoTarget } from "../../engine/gizmoTargetRegistry";
import {
  type ManagedTextRenderRole,
  shouldRenderManagedTextHeadline,
} from "../../engine/managedText";
import { useHeldLocalMs } from "../../engine/presentHold";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import {
  SceneDocContext,
  SceneTextClaimedContext,
  useSceneContext,
} from "../../engine/sceneContext";
import { registerSceneText } from "../../engine/sceneTextRegistry";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import { useTextMotionRegistry } from "../../engine/textMotionRegistry";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { formatFontString, parseFontString } from "../../theme/fontRef";
import { fontUrl } from "../../theme/fonts";
import type { FontRef, TextAnimationSpec, TextLookSpec, Theme } from "../../theme/tokens";
import { foldBandToChild, GroupAnimationContext } from "../group/context";
import { LookText3D } from "../text3d/LookText3D";
import type { EaseName, V3 } from "../types";
import {
  caretQuad,
  EMOJI_QUAD_EM,
  type EmojiQuadState,
  EmojiQuads,
  sweepCoverage,
} from "./EmojiQuads";
import { type PreparedEmojiText, prepareEmojiText } from "./emojiText";
import { computeUnitYExtents, HighlightQuads } from "./HighlightQuads";
import {
  arcGlyphTransform,
  arcSpec,
  FROSTED_SHINE_INTENSITY,
  FROSTED_SHINE_TINT,
  FROSTED_SHINE_U,
  frostedDeltas,
  gradientSpan,
  gradientStops,
  lookColorA,
  neonCoreFill,
  neonHalo,
  OFFSET_PRINT_Z_EM,
  outlineStroke,
} from "./lookStyle";
import {
  lookIs3d,
  lookNeedsShaderPath,
  type ResolvedTextLook,
  resolveTextLookWithDoc,
} from "./looks";
import {
  BLUR_EM,
  computeStaggerUnits,
  DEFAULT_START_SCALE,
  EDGE_SENTINEL,
  hasOwnAnimationProps,
  presetNeedsShaderPath,
  type ResolvedTextAnimation,
  resolveTextAnimationWithDoc,
  type ScatterSampleContext,
  type StaggerUnits,
  sampleTextUnit,
  type TextAnimTiming,
  type TextDelivery,
  type TextDirection,
  type TextPresetName,
  type TextUnitSample,
  TWIST_START_SCALE,
  textAnimationEndMs,
  textAnimationWindowToMs,
  textPresetHasMotion,
  underlineProgress,
  unitIndexForKey,
} from "./presets";
import {
  CHROMA_ECHO_Z_EM,
  CLIP_PAD_X_EM,
  createStaggerTextMaterial,
  type StaggerPackFrame,
  writeArcUniforms,
  writeGlintUniforms,
  writeGradientUniforms,
  writeHeldShineUniforms,
  writeShineBand,
  writeShineUniforms,
  writeStaggerUniforms,
} from "./staggerMaterial";
import { UnderlineRule } from "./UnderlineRule";

export interface AnimatedHeadlineProps {
  text: string;
  /** Reveal start, in ms (local scene time). */
  from?: number;
  /** Reveal end, in ms (local scene time). */
  to?: number;
  /** In-animation preset. Defaults to the theme's `textAnimation.in`. */
  preset?: TextPresetName;
  /** Out-animation preset; plays only when `outAt` is set. Defaults to `textAnimation.out`. */
  outPreset?: TextPresetName;
  /** Out start, in ms; the out plays over the same duration as the in. */
  outAt?: number;
  /** Per-char / per-word stagger granularity. Paragraph delivery is spelled through `delivery`, never here. */
  stagger?: "char" | "word";
  /** Per-unit stagger delay, ms. Defaults to the theme's `textAnimation.staggerMs`. */
  staggerMs?: number;
  /** Hold before the in starts, ms (clamped ≥ 0; the out never shifts). Defaults to `textAnimation.delayMs`. */
  delayMs?: number;
  /** fade-scale: starting scale, landing at 1 (default 0.8, clamped 0.05-4). */
  startScale?: number;
  /** fade-scale: sweep the soft white shine band once during the scale-in. */
  shine?: boolean;
  /** twist-scale: the side the card turns in from (default "from-left"). */
  direction?: TextDirection;
  /** all-at-once / by-paragraph / by-paragraph-group. Paragraphs split on `\n`, groups on blank lines; all-at-once forces the whole-block path. */
  delivery?: TextDelivery;
  /** Easing for preset animations. Defaults to the theme's `motion.easings.standard`. */
  ease?: EaseName;
  /** Which theme face renders the text: the headline or body font. */
  face?: "headline" | "body";
  /** Theme colour token filling the text, or a raw sRGB hex (the per-scene text-colour escape hatch; tokens stay the default). Setting this pins the fill: the sidecar can no longer override it and the Edit-text drill-in shows no swatch. Prefer `defaultColor` on sidecar-driven scenes. */
  color?: "text" | "muted" | "accent" | (string & {});
  /** The sidecar text key this headline renders (what `useSceneText` was called with): enables the app-editable fill (`textStyle.<textKey>Color` in the scene document) and registers the field's colour swatch in the inspector. */
  textKey?: string;
  /** Compatibility-only style source when the stable managed key differs from an older sidecar style key. */
  styleKey?: string;
  /** Compatibility-only motion source when the stable managed key differs from an older keyed override. */
  motionKey?: string;
  /** Fill when neither `color` nor the sidecar set one (default "text"): the token a scene wants as its design default while staying app-editable. */
  defaultColor?: "text" | "muted" | "accent" | (string & {});
  position?: V3;
  fontSize?: number;
  /** Explicit font override replacing the theme face; also how the dispatcher applies a sidecar `<textKey>Font`. */
  fontRef?: FontRef;
  /** Per-line alignment inside the measured block (visible on multi-line text only). */
  textAlign?: "left" | "center" | "right";
  /** Where `position` sits on the block's X axis (default "center", the legacy contract). */
  anchorX?: "left" | "center" | "right";
  /** Where `position` sits on the block's Y axis (default troika "middle"); "top" anchors multi-line blocks by their top edge so following content can budget below them. */
  anchorY?: "top" | "middle" | "bottom";
  /** Wrap width in world units; unset means no wrapping, `\n` is the only line break. */
  maxWidth?: number;
  /** Line spacing as a multiple of the font size; unset means troika's own "normal" (the font's metrics), which is also how the dispatcher applies a sidecar `<textKey>LineHeight`. */
  lineHeight?: number;
  /** Scene text stands down when `managedText` is present. Embedded composition text opts out; managed renderer nodes opt back in. */
  managedTextRole?: ManagedTextRenderRole;
  /** Effective coded parent motion to retain if the inspector takes ownership of this line. */
  managedTextCodedMotion?: TextAnimationSpec;
  /** Text-look preset name (the style catalogue); resolution follows the textAnimation pattern (theme default → sidecar `textLook` → props, `textLookForce` flips the order). */
  look?: string;
  /** Look parameter overrides riding beside `look` (colours, angle, stroke, intensity, offset, curve). */
  lookParams?: Partial<TextLookSpec>;
}

/** Layout props forwarded to troika; spread-conditional so an unset prop can never disturb troika's own defaults (the legacy byte contract). */
function layoutProps(props: AnimatedHeadlineProps) {
  return {
    ...(props.textAlign ? { textAlign: props.textAlign } : {}),
    ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {}),
    ...(props.anchorY ? { anchorY: props.anchorY } : {}),
    ...(props.lineHeight !== undefined ? { lineHeight: props.lineHeight } : {}),
  };
}

/** Token lookup stays byte-identical; anything else is a raw fill. */
function resolveFill(theme: Theme, color: string): string {
  if (color === "text" || color === "muted" || color === "accent") return theme.colors[color];
  return color;
}

/** Resolve the token-keyed face + fill for one headline (shared by all three paths). */
function textStyle(theme: Theme, props: AnimatedHeadlineProps) {
  return {
    font: fontUrl(props.fontRef ?? theme.typography[props.face ?? "headline"]),
    fill: resolveFill(theme, props.color ?? "text"),
  };
}

// Mount-constant pack looks keyed by preset name (string sets: the names live in presets.ts).
const CHROMA_PRESETS: ReadonlySet<string> = new Set(["chromatic"]);
const GLINT_PRESETS: ReadonlySet<string> = new Set(["glint-wipe"]);
const SHINE_DRIVEN_PRESETS: ReadonlySet<string> = new Set(["line-stretch", "glint-wipe"]);
const HIGHLIGHT_PRESETS: ReadonlySet<string> = new Set(["highlight-wipe"]);
const UNDERLINE_PRESETS: ReadonlySet<string> = new Set(["underline-draw"]);

function usesPreset(set: ReadonlySet<string>, anim: ResolvedTextAnimation): boolean {
  return set.has(anim.preset) || set.has(anim.outPreset);
}

/** Shader-path presets at granularity null still mount the staggered path with ONE whole-block unit spanning the measured bounds. */
function blockStaggerUnits(b: readonly [number, number, number, number]): StaggerUnits {
  return {
    count: 1,
    startX: new Float32Array([b[0]]),
    endX: new Float32Array([b[2]]),
    edgeKey: new Float32Array([EDGE_SENTINEL]),
    centerY: new Float32Array([(b[1] + b[3]) / 2]),
    axis: "x",
  };
}

/** SDF headline rendered through troika (via drei `<Text>`); all motion is a pure function of the timeline, never the wall clock. Three render paths chosen once per mount: LEGACY (nothing configured, the original v0 linear fillOpacity ramp byte-for-byte, must not change), BLOCK (preset without stagger, whole-block opacity/offset/blur/clip via troika props), and STAGGERED (staggerMs > 0, one mesh with a per-glyph derived material). */
export function AnimatedHeadline(props: AnimatedHeadlineProps) {
  const doc = useContext(SceneDocContext);
  const claimed = useContext(SceneTextClaimedContext);
  const role = props.managedTextRole ?? "scene";
  if (!shouldRenderManagedTextHeadline(doc, role, claimed)) return null;
  return <AnimatedHeadlineRenderer {...props} />;
}

function AnimatedHeadlineRenderer(props: AnimatedHeadlineProps) {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const ctx = useSceneContext();
  const sceneIndex = ctx?.index;
  // Report coded motion to the registry; the Text-motion panel warns and offers the sidecar force override instead of silently losing the user's pick.
  const coded = hasOwnAnimationProps(props);
  useEffect(() => {
    if (!coded || sceneIndex === undefined) return;
    useTextMotionRegistry.getState().register(sceneIndex);
    return () => useTextMotionRegistry.getState().unregister(sceneIndex);
  }, [coded, sceneIndex]);
  const anim = resolveTextAnimationWithDoc(props, theme, doc, props.motionKey ?? props.textKey);
  const animPreset = anim?.preset;
  const animOutPreset = anim?.outPreset;
  const animEase = anim?.ease;
  const animStaggerMs = anim?.staggerMs;
  const animGranularity = anim?.granularity;
  const animDelayMs = anim?.delayMs;
  const animDurationMs = anim?.durationMs;
  const animDistance = anim?.distance;
  const animStartScale = anim?.params.startScale;
  const animTwistStartScale = anim?.params.twistStartScale;
  const animShine = anim?.params.shine;
  const animTwistDir = anim?.params.twistDir;
  const codedMotion = useMemo<TextAnimationSpec | undefined>(() => {
    if (!coded || !animPreset || !animOutPreset || animStaggerMs === undefined) return undefined;
    const motion: TextAnimationSpec = {
      in: animPreset,
      out: animOutPreset,
      staggerMs: animStaggerMs,
      ease: animEase,
      ...(animDelayMs !== undefined ? { delayMs: animDelayMs } : {}),
      ...(animDurationMs !== undefined ? { durationMs: animDurationMs } : {}),
      ...(animDistance !== undefined ? { distance: animDistance } : {}),
    };
    if (animGranularity === "char" || animGranularity === "word") {
      motion.stagger = animGranularity;
    } else if (animGranularity === "paragraph") {
      motion.delivery = "by-paragraph";
    } else if (animGranularity === "paragraph-group") {
      motion.delivery = "by-paragraph-group";
    } else if (props.delivery === "all-at-once") {
      motion.delivery = "all-at-once";
    }
    if (animPreset === "fade-scale" && animStartScale !== undefined) {
      motion.startScale = animStartScale;
      if (animShine) motion.shine = true;
    }
    if (animPreset === "twist-scale" && animTwistDir !== undefined) {
      motion.startScale = animTwistStartScale ?? TWIST_START_SCALE;
      if (animShine) motion.shine = true;
      motion.direction = animTwistDir < 0 ? "from-right" : "from-left";
    }
    return motion;
  }, [
    coded,
    animPreset,
    animOutPreset,
    animEase,
    animStaggerMs,
    animGranularity,
    animDelayMs,
    animDurationMs,
    animDistance,
    animStartScale,
    animTwistStartScale,
    animShine,
    animTwistDir,
    props.delivery,
  ]);
  // The app-editable fill: an explicit `color` prop pins the fill (prop-wins, the text-motion precedent), otherwise the sidecar's `textStyle.<textKey>Color` overrides the design default. Report the editable field to the registry so the Edit-text drill-in shows its swatch; a pinned fill registers nothing (the swatch would be dead).
  const { textKey, defaultColor } = props;
  const styleKey = props.styleKey ?? textKey;
  const colorDefault = props.color === undefined && textKey ? (defaultColor ?? "text") : undefined;
  const styleOf = (suffix: string) =>
    styleKey ? doc?.textStyle?.[`${styleKey}${suffix}`] : undefined;
  const fill = props.color ?? (styleOf("Color") as string | undefined) ?? defaultColor;
  const fontValue = styleOf("Font");
  const sizeMul = styleOf("Size");
  const offX = styleOf("OffsetX");
  const offY = styleOf("OffsetY");
  const lineHeight = styleOf("LineHeight");
  const rotRaw = styleOf("RotationDeg");
  // The text look, resolved like the motion (theme → sidecar → props); "none" and unconfigured both mean the legacy fill path verbatim.
  const lookResolved = resolveTextLookWithDoc(
    { look: props.look, ...props.lookParams },
    theme,
    doc,
    styleKey,
  );
  // Report a coded look like coded motion, on stable scalars; the Text-style panel warns and offers the force override.
  const codedLookProps = props.look !== undefined || props.lookParams !== undefined;
  const lookPreset = lookResolved?.preset;
  const lookColorA = lookResolved?.colorA;
  const lookColorB = lookResolved?.colorB;
  const lookAngleDeg = lookResolved?.angleDeg;
  const lookStrokeEm = lookResolved?.strokeEm;
  const lookHollow = lookResolved?.hollow;
  const lookIntensity = lookResolved?.intensity;
  const lookOffsetEm = lookResolved?.offsetEm;
  const lookCurveDeg = lookResolved?.curveDeg;
  const codedLook = useMemo<TextLookSpec | undefined>(() => {
    if (!codedLookProps || lookPreset === undefined || lookPreset === "none") return undefined;
    const spec: TextLookSpec = { preset: lookPreset };
    if (lookColorA !== undefined) spec.colorA = lookColorA;
    if (lookColorB !== undefined) spec.colorB = lookColorB;
    if (lookAngleDeg !== undefined) spec.angleDeg = lookAngleDeg;
    if (lookStrokeEm !== undefined) spec.strokeEm = lookStrokeEm;
    if (lookHollow !== undefined) spec.hollow = lookHollow;
    if (lookIntensity !== undefined) spec.intensity = lookIntensity;
    if (lookOffsetEm !== undefined) spec.offsetEm = lookOffsetEm;
    if (lookCurveDeg !== undefined) spec.curveDeg = lookCurveDeg;
    return spec;
  }, [
    codedLookProps,
    lookPreset,
    lookColorA,
    lookColorB,
    lookAngleDeg,
    lookStrokeEm,
    lookHollow,
    lookIntensity,
    lookOffsetEm,
    lookCurveDeg,
  ]);
  const textRegistryMountId = useId();
  const registrationMotion = props.managedTextCodedMotion ?? codedMotion;
  const registrationColor = fill ?? "text";
  const registrationFont = formatFontString(
    typeof fontValue === "string"
      ? parseFontString(fontValue)
      : (props.fontRef ?? theme.typography[props.face ?? "headline"]),
  );
  useLayoutEffect(() => {
    if (sceneIndex === undefined || !textKey) return;
    useTextKeyRegistry.getState().register(sceneIndex, textKey, textRegistryMountId, {
      colorDefault,
      styleCapable: true,
      resolvedText: props.text,
      style: {
        color: registrationColor,
        font: registrationFont,
        size: typeof sizeMul === "number" ? sizeMul : 1,
        offsetX: typeof offX === "number" ? offX : 0,
        offsetY: typeof offY === "number" ? offY : 0,
        ...(typeof lineHeight === "number"
          ? { lineHeight }
          : props.lineHeight !== undefined
            ? { lineHeight: props.lineHeight }
            : {}),
        rotationDeg: typeof rotRaw === "number" ? rotRaw : 0,
      },
      ...(registrationMotion ? { codedMotion: registrationMotion } : {}),
      ...(codedLook ? { codedLook } : {}),
      managedTextRole: props.managedTextRole ?? "scene",
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey, textRegistryMountId);
  }, [
    sceneIndex,
    textKey,
    textRegistryMountId,
    colorDefault,
    registrationColor,
    registrationFont,
    props.text,
    props.lineHeight,
    sizeMul,
    offX,
    offY,
    lineHeight,
    rotRaw,
    registrationMotion,
    codedLook,
    props.managedTextRole,
  ]);
  // Sidecar font/size/offset/line-height overrides fold into the dispatched props; absent overrides pass the originals through untouched (null-for-legacy).
  // Rotation is deliberately NOT folded into `styled`: it changes no layout input, so the title cascade and the panel column never reflow around a tilt.
  const rotZ = typeof rotRaw === "number" && rotRaw !== 0 ? (-rotRaw * Math.PI) / 180 : 0;
  let styled = props;
  if (
    typeof fontValue === "string" ||
    typeof sizeMul === "number" ||
    typeof offX === "number" ||
    typeof offY === "number" ||
    typeof lineHeight === "number"
  ) {
    const base = props.position ?? [0, 0, 0];
    styled = {
      ...props,
      ...(typeof fontValue === "string" ? { fontRef: parseFontString(fontValue) } : {}),
      ...(typeof sizeMul === "number" ? { fontSize: (props.fontSize ?? 0.6) * sizeMul } : {}),
      ...(typeof lineHeight === "number" ? { lineHeight } : {}),
      ...(typeof offX === "number" || typeof offY === "number"
        ? {
            position: [
              base[0] + (typeof offX === "number" ? offX : 0),
              base[1] + (typeof offY === "number" ? offY : 0),
              base[2],
            ] as V3,
          }
        : {}),
    };
  }
  // Publish the mounted mesh and its measured block to the 2D gizmo registry; DOM-only readers, never the render path.
  const meshRef = useRef<Object3D | null>(null);
  const targetKey = useId();
  const side = ctx?.side;
  useEffect(() => {
    if (sceneIndex === undefined || !textKey) return;
    registerGizmoTarget(targetKey, {
      domain: "text",
      sceneIndex,
      itemId: textKey,
      side,
      node: () => meshRef.current,
      localRect: () => {
        const b = (meshRef.current as (Object3D & CaretInfo) | null)?.textRenderInfo?.blockBounds;
        return b && b.length === 4 ? [b[0], b[1], b[2], b[3]] : null;
      },
    });
    return () => unregisterGizmoTarget(targetKey);
  }, [targetKey, sceneIndex, textKey, side]);
  // Report the text + resolved size; the Scene tab derives its default scene name from the scene's largest mounted text. UI-only, an effect.
  const registeredText = props.text;
  const registeredSize = styled.fontSize ?? 0.6;
  useEffect(() => {
    if (sceneIndex === undefined || typeof registeredText !== "string" || !registeredText.trim()) {
      return;
    }
    return registerSceneText(sceneIndex, registeredText, registeredSize);
  }, [sceneIndex, registeredText, registeredSize]);
  // Emoji clusters swap to placeholder codepoints before troika sees the string; identical text for emoji-free strings, so legacy bytes stay safe (the registry above keeps the ORIGINAL text).
  const prepared = useMemo(() => prepareEmojiText(props.text), [props.text]);
  const look = lookResolved !== null && lookResolved.preset !== "none" ? lookResolved : null;
  const look3d = look !== null && lookIs3d(look.preset);
  const emojiIn3d = look3d && prepared.clusters.length > 0;
  if (emojiIn3d && look) warnEmoji3dFallback(look.preset);
  // The flat paths never see a 3D look; an emoji fallback drops the look entirely (do not mix).
  const activeLook = look3d ? null : look;
  const lookOnlyAnim = useMemo<ResolvedTextAnimation>(
    () => ({
      preset: "none",
      outPreset: "none",
      ease: theme.motion.easings.standard,
      staggerMs: 0,
      granularity: null,
      params: { startScale: DEFAULT_START_SCALE, shine: false, twistDir: 1 },
    }),
    [theme],
  );
  const hasOut = anim !== null && textPresetHasMotion(anim.outPreset) && props.outAt !== undefined;
  const authoredToMs = props.to ?? 600;
  // The window `to` carries the in DURATION (a delay must not stretch it); present timing holds until the delayed in genuinely lands.
  const windowToMs = anim
    ? textAnimationWindowToMs(props.from ?? 0, authoredToMs, anim)
    : authoredToMs;
  const holdToMs = anim ? textAnimationEndMs(props.from ?? 0, authoredToMs, anim) : authoredToMs;
  const holdOutMs = hasOut ? props.outAt : undefined;
  useEffect(() => {
    if (sceneIndex === undefined) return;
    return registerPresentTiming(sceneIndex, { kind: "text", toMs: holdToMs, outAtMs: holdOutMs });
  }, [sceneIndex, holdToMs, holdOutMs]);
  const legacyMotion = anim === null || (anim.preset === "none" && !hasOut);
  const animated = windowToMs === authoredToMs ? styled : { ...styled, to: windowToMs };
  if (look3d && !emojiIn3d && look !== null) {
    // 3D looks re-render as an extruded twin; motion degrades to whole-block transforms from the unit-0 sample (legacyMotion keeps the v0 linear ramp on material opacity).
    return (
      <LookText3D
        text={props.text}
        look={look}
        theme={theme}
        anim={legacyMotion ? null : anim}
        from={animated.from}
        to={animated.to}
        outAt={animated.outAt}
        position={animated.position}
        fontSize={animated.fontSize}
        fontRef={animated.fontRef}
        face={animated.face}
        anchorX={animated.anchorX}
        anchorY={animated.anchorY}
        rotZ={rotZ}
        meshRef={meshRef}
      />
    );
  }
  if (anim === null || (anim.preset === "none" && !hasOut)) {
    if (activeLook !== null && lookNeedsShaderPath(activeLook.preset)) {
      // A shader look with no motion configured mounts the staggered path anyway (one block unit) and folds the v0 linear ramp back in via legacyReveal.
      return (
        <StaggeredHeadline
          {...styled}
          color={fill}
          theme={theme}
          anim={anim ?? lookOnlyAnim}
          lookSpec={activeLook}
          legacyReveal
          prepared={prepared}
          meshRef={meshRef}
          rotZ={rotZ}
        />
      );
    }
    return (
      <LegacyHeadline
        {...styled}
        color={fill}
        theme={theme}
        lookSpec={activeLook}
        prepared={prepared}
        meshRef={meshRef}
        rotZ={rotZ}
      />
    );
  }
  // Pack presets (and the shader looks) need the derived material's per-unit terms even whole-block: force the staggered path (one block unit) instead of BlockHeadline.
  const shaderPath =
    presetNeedsShaderPath(anim.preset) ||
    presetNeedsShaderPath(anim.outPreset) ||
    (activeLook !== null && lookNeedsShaderPath(activeLook.preset));
  if ((anim.granularity && anim.staggerMs > 0) || shaderPath) {
    return (
      <StaggeredHeadline
        {...animated}
        color={fill}
        theme={theme}
        anim={anim}
        lookSpec={activeLook}
        prepared={prepared}
        meshRef={meshRef}
        rotZ={rotZ}
      />
    );
  }
  return (
    <BlockHeadline
      {...animated}
      color={fill}
      theme={theme}
      anim={anim}
      lookSpec={activeLook}
      prepared={prepared}
      meshRef={meshRef}
      rotZ={rotZ}
    />
  );
}

let warnedEmoji3d = false;
function warnEmoji3dFallback(preset: string): void {
  if (warnedEmoji3d) return;
  warnedEmoji3d = true;
  console.warn(`[text] emoji cannot extrude; "${preset}" falls back to the flat text path`);
}

/** Shared caret capture: quads only mount once the first typeset reports positions. */
type CaretInfo = { textRenderInfo?: { caretPositions?: Float32Array; blockBounds?: number[] } };

/** What every render path needs from the host: the mesh handle the gizmo registry publishes, and the sidecar tilt (0 means no rotation prop is passed at all, so an untouched project's tree is unchanged). */
type HeadlineHost = { meshRef: RefObject<Object3D | null>; rotZ: number };

/** The v0 path, verbatim, the null-for-legacy contract for every pre-v8 project (role/color default to the original headline-face/text-token resolution, so pixels cannot move); inside an `AnimatedGroup` the group's alpha multiplies in (× 1 is fp-exact outside groups) and shine-capable groups mount the band material, both structurally inert when there is no group, so legacy bytes stay safe. Emoji quads (and their caret capture) mount only when the text actually contains emoji. */
function LegacyHeadline(
  props: AnimatedHeadlineProps &
    HeadlineHost & { theme: Theme; prepared: PreparedEmojiText; lookSpec: ResolvedTextLook | null },
) {
  const {
    from = 0,
    to = 600,
    position = [0, 0, 0],
    fontSize = 0.6,
    theme,
    prepared,
    meshRef,
    rotZ,
    lookSpec,
  } = props;
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const { font, fill } = textStyle(theme, props);
  // The plain-prop looks (outline, neon); all conditionals resolve to the legacy values when no look is configured.
  const accent = theme.colors.accent;
  const stroke = lookSpec?.preset === "outline" ? outlineStroke(lookSpec, accent, fontSize) : null;
  const halo = lookSpec?.preset === "neon" ? neonHalo(lookSpec, accent, fontSize) : null;
  const coreFill = lookSpec?.preset === "neon" ? neonCoreFill(fill, lookSpec.intensity) : fill;
  const reveal = to <= from ? 1 : Math.min(1, Math.max(0, (localMs - from) / (to - from)));
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);

  const groupShine = group?.shineCapable === true;
  const holder = useMemo(
    () => (groupShine ? createStaggerTextMaterial({ shine: true }) : null),
    [groupShine],
  );
  useEffect(() => () => holder?.dispose(), [holder]);
  if (holder) writeShineBand(holder, foldBandToChild(group, position));

  const alpha = reveal * (group?.alpha ?? 1);
  const states: EmojiQuadState[] = [];
  if (hasEmoji && carets) {
    for (const cluster of prepared.clusters) {
      const q = caretQuad(carets, cluster.codeUnitIndex);
      if (!q) continue;
      states.push({
        key: cluster.key,
        x: q.x,
        y: q.y,
        alpha,
        scale: 1,
        dx: 0,
        dy: 0,
        dz: 0,
        rotYRad: 0,
        rotYPivotX: q.x,
        rotZRad: 0,
        coverage: 1,
      });
    }
  }

  return (
    <>
      <Text
        ref={meshRef}
        font={font}
        position={position}
        fontSize={fontSize}
        color={coreFill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        fillOpacity={stroke && lookSpec?.hollow ? 0 : alpha}
        {...(stroke
          ? {
              strokeWidth: stroke.strokeWidth,
              strokeColor: stroke.strokeColor,
              strokeOpacity: alpha,
            }
          : {})}
        {...(halo
          ? {
              outlineBlur: halo.outlineBlur,
              outlineColor: halo.outlineColor,
              outlineOpacity: halo.outlineOpacity * alpha,
            }
          : {})}
        {...layoutProps(props)}
        {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
        {...(holder ? { material: holder.material } : {})}
        onSync={
          hasEmoji
            ? (troika: CaretInfo) => {
                const c = troika.textRenderInfo?.caretPositions;
                if (c) setCarets(c);
              }
            : undefined
        }
      >
        {prepared.text}
      </Text>
      {hasEmoji && (
        <group position={position} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        </group>
      )}
    </>
  );
}

type Bounds = readonly [number, number, number, number];

function BlockHeadline(
  props: AnimatedHeadlineProps &
    HeadlineHost & {
      theme: Theme;
      anim: ResolvedTextAnimation;
      prepared: PreparedEmojiText;
      lookSpec: ResolvedTextLook | null;
    },
) {
  const {
    from = 0,
    to = 600,
    outAt,
    position = [0, 0, 0],
    fontSize = 0.6,
    theme,
    anim,
    prepared,
    meshRef,
    rotZ,
    lookSpec,
  } = props;
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);

  const timing: TextAnimTiming = { anim, from, to, outAt };
  const sample = sampleTextUnit(timing, 0, localMs);
  const { font, fill } = textStyle(theme, props);

  const masked = anim.preset === "mask-reveal" || anim.outPreset === "mask-reveal";
  // Shine is a fade-scale scale-IN feature: the block mounts the derived material purely for the band (unit uniforms stay neutral; fillOpacity and the group transform keep doing the block work, troika merges its uniforms through the chain); a shine-capable `AnimatedGroup` also mounts it, the child's OWN shine wins the single band slot (explicit prop over inherited), else the group band lands pre-folded into this child's local space.
  const ownShine =
    anim.params.shine && (anim.preset === "fade-scale" || anim.preset === "twist-scale");
  const shining = ownShine || group?.shineCapable === true;
  const holder = useMemo(
    () => (shining ? createStaggerTextMaterial({ shine: true }) : null),
    [shining],
  );
  useEffect(() => () => holder?.dispose(), [holder]);
  if (holder) {
    if (ownShine) writeShineUniforms(holder, bounds, sample.shineU);
    else writeShineBand(holder, foldBandToChild(group, position));
  }

  // Until the first typeset reports bounds, a partial sweep clips to nothing; the measured rect lands on the next committed frame (deterministic in preview AND export). An unclipped state must be spelled null, never undefined: r3f leaves a prop that merely disappears at its previous value (troika itself clears a clip with null, the JSX cast covers drei's narrower typing), so a seek jumping from pre-reveal (zero-width rect) straight past `to` would keep the stale rect and clip the text to nothing forever (the invisible mask-reveal title bug).
  const clipRect = masked ? (sweepToClipRect(sample.sweep, bounds) ?? null) : null;
  const blurring = anim.preset === "blur-in" || anim.outPreset === "blur-in";
  const haloOpacity = blurring ? Math.min(1, sample.blurEm / BLUR_EM) : 0;
  const measuring = masked || ownShine;
  // The plain-prop looks. Neon + blur-in share the outline slots: the look owns the colour, blur-in's radius folds in additively, opacity takes the stronger (the transient halo wins mid-entry, neon holds after).
  const accent = theme.colors.accent;
  const stroke = lookSpec?.preset === "outline" ? outlineStroke(lookSpec, accent, fontSize) : null;
  const halo = lookSpec?.preset === "neon" ? neonHalo(lookSpec, accent, fontSize) : null;
  const coreFill = lookSpec?.preset === "neon" ? neonCoreFill(fill, lookSpec.intensity) : fill;

  const alpha = sample.alpha * (group?.alpha ?? 1);
  const states: EmojiQuadState[] = [];
  if (hasEmoji && carets) {
    // Quads ride the block transform via the wrapping group; only alpha and the mask-reveal coverage are per-quad.
    const partialSweep = masked && (sample.sweep[0] > 0 || sample.sweep[1] < 1);
    const halfW = (EMOJI_QUAD_EM * fontSize) / 2;
    for (const cluster of prepared.clusters) {
      const q = caretQuad(carets, cluster.codeUnitIndex);
      if (!q) continue;
      let coverage = 1;
      if (partialSweep) {
        if (!bounds) coverage = 0;
        else {
          const w = bounds[2] - bounds[0];
          coverage = sweepCoverage(
            q.x,
            halfW,
            bounds[0] + sample.sweep[0] * w,
            bounds[0] + sample.sweep[1] * w,
          );
        }
      }
      states.push({
        key: cluster.key,
        x: q.x,
        y: q.y,
        alpha,
        scale: 1,
        dx: 0,
        dy: 0,
        dz: 0,
        rotYRad: 0,
        rotYPivotX: q.x,
        rotZRad: 0,
        coverage,
      });
    }
  }

  return (
    <group
      position={[
        position[0] + sample.dxEm * fontSize,
        position[1] + sample.dyEm * fontSize,
        position[2] + sample.dzEm * fontSize,
      ]}
      rotation={[0, sample.rotYRad, rotZ ? sample.rotZRad + rotZ : sample.rotZRad]}
      scale={sample.scale}
    >
      <Text
        ref={meshRef}
        font={font}
        fontSize={fontSize}
        color={coreFill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        fillOpacity={stroke && lookSpec?.hollow ? 0 : alpha}
        {...(stroke
          ? {
              strokeWidth: stroke.strokeWidth,
              strokeColor: stroke.strokeColor,
              strokeOpacity: alpha,
            }
          : {})}
        {...layoutProps(props)}
        clipRect={clipRect as unknown as [number, number, number, number] | undefined}
        outlineBlur={
          halo
            ? halo.outlineBlur + (blurring ? sample.blurEm * fontSize : 0)
            : blurring
              ? sample.blurEm * fontSize
              : 0
        }
        outlineColor={halo ? halo.outlineColor : fill}
        outlineOpacity={halo ? Math.max(halo.outlineOpacity * alpha, haloOpacity) : haloOpacity}
        {...(holder ? { material: holder.material } : {})}
        onSync={
          measuring || hasEmoji
            ? (troika: CaretInfo) => {
                const info = troika.textRenderInfo;
                const b = info?.blockBounds;
                if ((measuring || hasEmoji) && b && b.length === 4) {
                  setBounds([b[0], b[1], b[2], b[3]]);
                }
                if (hasEmoji && info?.caretPositions) setCarets(info.caretPositions);
              }
            : undefined
        }
      >
        {prepared.text}
      </Text>
      {hasEmoji && <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />}
    </group>
  );
}

function sweepToClipRect(
  sweep: readonly [number, number],
  bounds: Bounds | null,
): [number, number, number, number] | undefined {
  if (sweep[0] <= 0 && sweep[1] >= 1) return undefined;
  if (!bounds) return [0, 0, 0, 0];
  const [minX, minY, maxX, maxY] = bounds;
  const w = maxX - minX;
  return [minX + sweep[0] * w, minY, minX + sweep[1] * w, maxY];
}

function StaggeredHeadline(
  props: AnimatedHeadlineProps &
    HeadlineHost & {
      theme: Theme;
      anim: ResolvedTextAnimation;
      prepared: PreparedEmojiText;
      lookSpec: ResolvedTextLook | null;
      /** Fold the v0 linear reveal ramp in (a shader look mounted with no motion configured). */
      legacyReveal?: boolean;
    },
) {
  const {
    from = 0,
    to = 600,
    outAt,
    position = [0, 0, 0],
    fontSize = 0.6,
    theme,
    anim,
    prepared,
    meshRef,
    rotZ,
    lookSpec,
  } = props;
  const text = prepared.text;
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const granularity = anim.granularity ?? "word";
  // Pack presets at granularity null run whole-block through this path (one unit from the measured bounds, never a word split).
  const blockUnit = anim.granularity === null;
  // Variant flags are mount-constant (the resolved animation cannot change without a scene remount): the walk axis follows the granularity (paragraphs are vertically disjoint, so the walk keys on −Y), twist mounts the per-unit card turn, and shine stays ELEMENT-level (one band over the whole text, driven by unit 0); a shine-capable `AnimatedGroup` also mounts the shine variant, the child's OWN shine wins the single band slot, else the group band lands pre-folded. Pack presets mount the v2 terms; chromatic adds two echo materials; glint-wipe swaps the band to the tinted variant. The look flags are mount-constant too (a resolved look cannot change preset without a remount).
  const lookName = lookSpec?.preset;
  const lookGradient = lookName === "gradient";
  const lookArc = lookName === "arc";
  const lookFrosted = lookName === "frosted";
  const lookOffsetPrint = lookName === "offset-print";
  const lookHighlight = lookName === "highlight-block";
  const axis = granularity === "paragraph" || granularity === "paragraph-group" ? "-y" : "x";
  // frosted rides the pack fields (weight/soft re-threshold), so it forces the pack sandwich.
  const pack =
    presetNeedsShaderPath(anim.preset) || presetNeedsShaderPath(anim.outPreset) || lookFrosted;
  const twisting = anim.preset === "twist-scale" || anim.outPreset === "twist-scale";
  const glinting = usesPreset(GLINT_PRESETS, anim);
  const ownShine =
    (anim.params.shine && (anim.preset === "fade-scale" || anim.preset === "twist-scale")) ||
    usesPreset(SHINE_DRIVEN_PRESETS, anim);
  const shining = ownShine || group?.shineCapable === true;
  const scattering = anim.preset === "scatter-scale" || anim.outPreset === "scatter-scale";
  const chroming = usesPreset(CHROMA_PRESETS, anim);
  const highlighting = usesPreset(HIGHLIGHT_PRESETS, anim);
  const underlining = usesPreset(UNDERLINE_PRESETS, anim);
  const holder = useMemo(
    () =>
      createStaggerTextMaterial({
        shine: shining,
        shineTint: glinting || lookFrosted,
        axis,
        twist: twisting,
        scatter: scattering,
        pack,
        gradient: lookGradient,
        arc: lookArc,
      }),
    [shining, glinting, axis, twisting, scattering, pack, lookGradient, lookArc, lookFrosted],
  );
  useEffect(() => () => holder.dispose(), [holder]);
  const echoHolders = useMemo(
    () =>
      chroming
        ? ([
            createStaggerTextMaterial({ axis, echo: 1, gradient: lookGradient, arc: lookArc }),
            createStaggerTextMaterial({ axis, echo: -1, gradient: lookGradient, arc: lookArc }),
          ] as const)
        : null,
    [chroming, axis, lookGradient, lookArc],
  );
  useEffect(() => {
    if (!echoHolders) return;
    return () => {
      for (const echo of echoHolders) echo.dispose();
    };
  }, [echoHolders]);
  // offset-print's single tinted under-layer (the chromatic echo mount generalised): the same motion features, its own fill, offset CPU-side.
  const offsetHolder = useMemo(
    () =>
      lookOffsetPrint
        ? createStaggerTextMaterial({ axis, twist: twisting, scatter: scattering, pack })
        : null,
    [lookOffsetPrint, axis, twisting, scattering, pack],
  );
  useEffect(() => () => offsetHolder?.dispose(), [offsetHolder]);
  const accent = theme.colors.accent;
  const accentColor = useMemo(() => new Color(accent), [accent]);
  // Look colours memoise on their hex strings, so the per-render resolve allocation never churns a Color (or a derived material) per frame.
  const lookAHex = lookSpec ? lookColorA(lookSpec, accent) : null;
  const gradBHex = lookSpec && lookGradient ? gradientStops(lookSpec, accent).b : null;
  const lookAColor = useMemo(() => (lookAHex ? new Color(lookAHex) : null), [lookAHex]);
  const gradBColor = useMemo(() => (gradBHex ? new Color(gradBHex) : null), [gradBHex]);
  const frostTint = useMemo(
    () => (lookFrosted ? new Color(FROSTED_SHINE_TINT) : null),
    [lookFrosted],
  );
  const [units, setUnits] = useState<StaggerUnits | null>(null);
  const [unitBoxes, setUnitBoxes] = useState<Float32Array | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  // highlight-block keeps its OWN word units (independent of the motion granularity) for the persistent blocks.
  const [lookWordUnits, setLookWordUnits] = useState<StaggerUnits | null>(null);
  const [lookWordBoxes, setLookWordBoxes] = useState<Float32Array | null>(null);

  // The stagger spread is only known after the first typeset; the dispatcher's entry covers the base window meanwhile.
  const sceneIndex = useSceneContext()?.index;
  const spreadMs = units ? Math.max(0, units.count - 1) * anim.staggerMs : null;
  // A resolved delay lands the whole spread that much later (the window `to` excludes it).
  const settleToMs = anim.delayMs === undefined ? to : to + anim.delayMs;
  useEffect(() => {
    if (sceneIndex === undefined || spreadMs === null || spreadMs <= 0) return;
    return registerPresentTiming(sceneIndex, {
      kind: "text",
      toMs: settleToMs,
      staggerSpreadMs: spreadMs,
    });
  }, [sceneIndex, spreadMs, settleToMs]);

  const timing: TextAnimTiming = { anim, from, to, outAt };
  const { font, fill } = textStyle(theme, props);
  const count = units ? Math.max(1, units.count) : 1;
  const measuring = ownShine || scattering || pack || lookGradient || lookArc;
  // scatter-scale's tilt drift (and the pack's centre-relative moves) need each unit's centre relative to the element centre (em); the element centre comes from the measured blockBounds (anchor-centred ≈ 0).
  const elemCX = bounds ? (bounds[0] + bounds[2]) / 2 : 0;
  const elemCY = bounds ? (bounds[1] + bounds[3]) / 2 : 0;
  // Group alpha folds into every unit's alpha CPU-side (× 1 fp-exact outside groups, so the uploaded uniform floats cannot move on standing projects); legacyReveal mounts fold the v0 linear ramp in the same way.
  const legacyAlpha = props.legacyReveal
    ? to <= from
      ? 1
      : Math.min(1, Math.max(0, (localMs - from) / (to - from)))
    : 1;
  const groupAlpha = (group?.alpha ?? 1) * legacyAlpha;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const ctx: ScatterSampleContext | undefined =
      scattering || pack
        ? {
            count,
            unitCenterEm:
              units && i < units.count
                ? [
                    ((units.startX[i] + units.endX[i]) / 2 - elemCX) / fontSize,
                    (units.centerY[i] - elemCY) / fontSize,
                  ]
                : undefined,
          }
        : undefined;
    const sample = sampleTextUnit(timing, i, localMs, ctx);
    sample.alpha *= groupAlpha;
    samples.push(sample);
  }
  // frosted: a constant soften + weight gain on every unit, riding the pack fields (exactly zero at intensity 0).
  if (lookFrosted && lookSpec) {
    const frost = frostedDeltas(lookSpec.intensity);
    for (const sample of samples) {
      sample.softEm += frost.softEm;
      sample.weightEm += frost.weightEm;
    }
  }
  // clipFinal rects: each unit's FINAL layout box (padded sideways, vertical caret extents) built once per frame from the measured extents; absent extents leave the clip open until the measure commits.
  let clipRects: Float32Array | null = null;
  if (pack && units && unitBoxes && samples.some((s) => s.clipFinal)) {
    clipRects = new Float32Array(count * 4);
    const padX = CLIP_PAD_X_EM * fontSize;
    for (let i = 0; i < count && i < units.count; i++) {
      clipRects[i * 4] = units.startX[i] - padX;
      clipRects[i * 4 + 1] = unitBoxes[i * 2];
      clipRects[i * 4 + 2] = units.endX[i] + padX;
      clipRects[i * 4 + 3] = unitBoxes[i * 2 + 1];
    }
  }
  const packFrame: StaggerPackFrame | undefined = pack
    ? { accent: accentColor, clipRects }
    : undefined;
  writeStaggerUniforms(holder, units, samples, fontSize, packFrame);
  if (echoHolders) {
    for (const echo of echoHolders) writeStaggerUniforms(echo, units, samples, fontSize, packFrame);
  }
  if (offsetHolder) writeStaggerUniforms(offsetHolder, units, samples, fontSize, packFrame);
  // The look's frame terms: gradient's projection and arc's bend both derive from the measured block; unmeasured frames park the exact-identity guards.
  const lookArcSpec = lookSpec && lookArc ? arcSpec(bounds, lookSpec.curveDeg) : null;
  if (lookGradient && lookSpec && lookAColor && gradBColor) {
    const span = gradientSpan(bounds, lookSpec.angleDeg);
    writeGradientUniforms(holder, span, lookAColor, gradBColor);
    if (echoHolders) {
      for (const echo of echoHolders) writeGradientUniforms(echo, span, lookAColor, gradBColor);
    }
  }
  if (lookArc) {
    writeArcUniforms(holder, lookArcSpec);
    if (echoHolders) {
      for (const echo of echoHolders) writeArcUniforms(echo, lookArcSpec);
    }
  }
  // Element shine under stagger: unit 0 has delay 0, so its eased progress IS the block progress; the band sweeps the measured block once during the scale-in. Glint runs the tinted accent variant. frosted's held cool band stands down whenever the motion preset drives the one band slot.
  if (glinting) writeGlintUniforms(holder, bounds, samples[0].shineU, accentColor);
  else if (ownShine) writeShineUniforms(holder, bounds, samples[0].shineU);
  else if (lookFrosted && lookSpec) {
    writeHeldShineUniforms(
      holder,
      bounds,
      FROSTED_SHINE_U,
      FROSTED_SHINE_INTENSITY * lookSpec.intensity,
      frostTint ?? undefined,
    );
  } else if (shining) writeShineBand(holder, foldBandToChild(group, position));
  // highlight-block: persistent full-coverage word blocks on their OWN word units, each riding the motion sample of whichever motion unit contains it (so blocks track and fade with their words).
  let lookHighlightSamples: TextUnitSample[] | null = null;
  if (lookHighlight && lookWordUnits) {
    lookHighlightSamples = [];
    for (let i = 0; i < lookWordUnits.count; i++) {
      const key =
        axis === "-y"
          ? -lookWordUnits.centerY[i]
          : (lookWordUnits.startX[i] + lookWordUnits.endX[i]) / 2;
      const unit = unitIndexForKey(units, key);
      const base = samples[Math.min(unit, samples.length - 1)];
      lookHighlightSamples.push({ ...base, highlight: [0, 1] });
    }
  }

  const states: EmojiQuadState[] = [];
  if (hasEmoji && carets) {
    // Each quad joins exactly the stagger unit the shader would give a glyph at its caret centre, then mirrors that unit's sampled transform as real geometry.
    const halfW = (EMOJI_QUAD_EM * fontSize) / 2;
    for (const cluster of prepared.clusters) {
      const q = caretQuad(carets, cluster.codeUnitIndex);
      if (!q) continue;
      const unit = unitIndexForKey(units, axis === "-y" ? -q.y : q.x);
      const sample = samples[Math.min(unit, samples.length - 1)];
      let coverage = 1;
      if (units && unit < units.count && (sample.sweep[0] > 0 || sample.sweep[1] < 1)) {
        const w = units.endX[unit] - units.startX[unit];
        coverage = sweepCoverage(
          q.x,
          halfW,
          units.startX[unit] + sample.sweep[0] * w,
          units.startX[unit] + sample.sweep[1] * w,
        );
      } else if (sample.sweep[1] <= 0) {
        coverage = 0;
      }
      // clipFinal parity: the quad cannot hard-clip, so its box coverage inside the unit's final rect fades it through the mask edge.
      if (sample.clipFinal && clipRects && unit * 4 + 3 < clipRects.length) {
        const o = unit * 4;
        coverage *= sweepCoverage(
          q.x + sample.dxEm * fontSize,
          halfW,
          clipRects[o],
          clipRects[o + 2],
        );
        coverage *= sweepCoverage(
          q.y + sample.dyEm * fontSize,
          halfW,
          clipRects[o + 1],
          clipRects[o + 3],
        );
      }
      const unitCY = units && unit < units.count ? units.centerY[unit] : 0;
      // arc's CPU twin: the same rigid roll + displacement the shader applies, about this quad's rest centre.
      const arcT = lookArcSpec ? arcGlyphTransform(q.x, lookArcSpec) : null;
      states.push({
        key: cluster.key,
        x: q.x,
        y: q.y,
        alpha: sample.alpha,
        scale: sample.scale,
        dx: arcT ? sample.dxEm * fontSize + arcT.dx : sample.dxEm * fontSize,
        dy: arcT ? sample.dyEm * fontSize + arcT.dy : sample.dyEm * fontSize,
        dz: sample.dzEm * fontSize,
        rotYRad: sample.rotYRad,
        rotYPivotX:
          (twisting || pack) && units && unit < units.count
            ? (units.startX[unit] + units.endX[unit]) / 2
            : q.x,
        rotZRad: arcT ? sample.rotZRad + arcT.rotRad : sample.rotZRad,
        coverage,
        rotXRad: sample.rotXRad,
        rotXPivotY: sample.rotXRad === 0 ? 0 : unitCY,
        scaleX: sample.scaleX,
        scaleY: sample.scaleY,
      });
    }
  }

  // The plain-prop looks on the main mesh (per-unit alpha rides the derived chain, so no opacity multipliers here; the neon halo pass shares the chain too).
  const stroke = lookSpec?.preset === "outline" ? outlineStroke(lookSpec, accent, fontSize) : null;
  const halo = lookSpec?.preset === "neon" ? neonHalo(lookSpec, accent, fontSize) : null;
  const coreFill = lookSpec?.preset === "neon" ? neonCoreFill(fill, lookSpec.intensity) : fill;

  return (
    <>
      {offsetHolder && lookSpec && (
        <Text
          font={font}
          position={[
            position[0] + lookSpec.offsetEm * fontSize,
            position[1] - lookSpec.offsetEm * fontSize,
            position[2] - OFFSET_PRINT_Z_EM * fontSize,
          ]}
          fontSize={fontSize}
          color={lookAHex ?? accent}
          anchorX={props.anchorX ?? "center"}
          anchorY="middle"
          {...layoutProps(props)}
          {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
          material={offsetHolder.material}
        >
          {text}
        </Text>
      )}
      {echoHolders?.map((echo) => (
        <Text
          key={echo.features.echo}
          font={font}
          position={[position[0], position[1], position[2] - CHROMA_ECHO_Z_EM * fontSize]}
          fontSize={fontSize}
          color={fill}
          anchorX={props.anchorX ?? "center"}
          anchorY="middle"
          {...layoutProps(props)}
          {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
          material={echo.material}
        >
          {text}
        </Text>
      ))}
      <Text
        ref={meshRef}
        font={font}
        position={position}
        fontSize={fontSize}
        color={coreFill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        {...(stroke
          ? {
              strokeWidth: stroke.strokeWidth,
              strokeColor: stroke.strokeColor,
              ...(lookSpec?.hollow ? { fillOpacity: 0 } : {}),
            }
          : {})}
        {...(halo
          ? {
              outlineBlur: halo.outlineBlur,
              outlineColor: halo.outlineColor,
              outlineOpacity: halo.outlineOpacity,
            }
          : {})}
        {...layoutProps(props)}
        {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
        material={holder.material}
        onSync={(troika: CaretInfo) => {
          const info = troika.textRenderInfo;
          const caretPositions = info?.caretPositions;
          const b = info?.blockBounds;
          if (blockUnit) {
            if (b && b.length === 4) {
              setUnits(blockStaggerUnits([b[0], b[1], b[2], b[3]]));
              setUnitBoxes(new Float32Array([b[1], b[3]]));
            }
          } else if (caretPositions) {
            const next = computeStaggerUnits(text, granularity, caretPositions);
            setUnits(next);
            if (pack) setUnitBoxes(computeUnitYExtents(next, text, caretPositions));
          }
          if (lookHighlight && caretPositions) {
            const words = computeStaggerUnits(text, "word", caretPositions);
            setLookWordUnits(words);
            setLookWordBoxes(computeUnitYExtents(words, text, caretPositions));
          }
          if (caretPositions && hasEmoji) setCarets(caretPositions);
          if (measuring && b && b.length === 4) setBounds([b[0], b[1], b[2], b[3]]);
        }}
      >
        {text}
      </Text>
      {(highlighting || underlining || lookHighlight) && (
        <group position={position} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
          {lookHighlight && lookWordUnits && lookWordBoxes && lookHighlightSamples && (
            <HighlightQuads
              units={lookWordUnits}
              unitBoxes={lookWordBoxes}
              samples={lookHighlightSamples}
              fontSize={fontSize}
              color={lookAHex ?? accent}
            />
          )}
          {highlighting && units && unitBoxes && (
            <HighlightQuads
              units={units}
              unitBoxes={unitBoxes}
              samples={samples}
              fontSize={fontSize}
              color={accent}
            />
          )}
          {underlining && bounds && (
            <UnderlineRule
              bounds={bounds}
              draw={underlineProgress(timing, localMs)}
              fontSize={fontSize}
              color={accent}
              opacity={groupAlpha}
            />
          )}
        </group>
      )}
      {hasEmoji && (
        <group position={position} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        </group>
      )}
    </>
  );
}
