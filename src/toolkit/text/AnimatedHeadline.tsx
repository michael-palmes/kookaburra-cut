import { Text } from "@react-three/drei";
import { useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useHeldLocalMs } from "../../engine/presentHold";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { registerSceneText } from "../../engine/sceneTextRegistry";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import { useTextMotionRegistry } from "../../engine/textMotionRegistry";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { parseFontString } from "../../theme/fontRef";
import { fontUrl } from "../../theme/fonts";
import type { FontRef, Theme } from "../../theme/tokens";
import { foldBandToChild, GroupAnimationContext } from "../group/context";
import type { EaseName, V3 } from "../types";
import {
  caretQuad,
  EMOJI_QUAD_EM,
  type EmojiQuadState,
  EmojiQuads,
  sweepCoverage,
} from "./EmojiQuads";
import { type PreparedEmojiText, prepareEmojiText } from "./emojiText";
import {
  BLUR_EM,
  computeStaggerUnits,
  hasOwnAnimationProps,
  type ResolvedTextAnimation,
  resolveTextAnimationWithDoc,
  type ScatterSampleContext,
  type StaggerUnits,
  sampleTextUnit,
  type TextAnimTiming,
  type TextDelivery,
  type TextDirection,
  type TextPresetName,
  unitIndexForKey,
} from "./presets";
import {
  createStaggerTextMaterial,
  writeShineBand,
  writeShineUniforms,
  writeStaggerUniforms,
} from "./staggerMaterial";

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
}

/** Layout props forwarded to troika; spread-conditional so an unset prop can never disturb troika's own defaults (the legacy byte contract). */
function layoutProps(props: AnimatedHeadlineProps) {
  return {
    ...(props.textAlign ? { textAlign: props.textAlign } : {}),
    ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {}),
    ...(props.anchorY ? { anchorY: props.anchorY } : {}),
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

/** SDF headline rendered through troika (via drei `<Text>`); all motion is a pure function of the timeline, never the wall clock. Three render paths chosen once per mount: LEGACY (nothing configured, the original v0 linear fillOpacity ramp byte-for-byte, must not change), BLOCK (preset without stagger, whole-block opacity/offset/blur/clip via troika props), and STAGGERED (staggerMs > 0, one mesh with a per-glyph derived material). */
export function AnimatedHeadline(props: AnimatedHeadlineProps) {
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const sceneIndex = useSceneContext()?.index;
  // Report coded motion to the registry; the Text-motion panel warns and offers the sidecar force override instead of silently losing the user's pick.
  const coded = hasOwnAnimationProps(props);
  useEffect(() => {
    if (!coded || sceneIndex === undefined) return;
    useTextMotionRegistry.getState().register(sceneIndex);
    return () => useTextMotionRegistry.getState().unregister(sceneIndex);
  }, [coded, sceneIndex]);
  // The app-editable fill: an explicit `color` prop pins the fill (prop-wins, the text-motion precedent), otherwise the sidecar's `textStyle.<textKey>Color` overrides the design default. Report the editable field to the registry so the Edit-text drill-in shows its swatch; a pinned fill registers nothing (the swatch would be dead).
  const { textKey, defaultColor } = props;
  const colorDefault = props.color === undefined && textKey ? (defaultColor ?? "text") : undefined;
  useLayoutEffect(() => {
    if (sceneIndex === undefined || !textKey) return;
    useTextKeyRegistry.getState().register(sceneIndex, textKey, colorDefault, true);
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey);
  }, [sceneIndex, textKey, colorDefault]);
  const styleOf = (suffix: string) =>
    textKey ? doc?.textStyle?.[`${textKey}${suffix}`] : undefined;
  const fill = props.color ?? (styleOf("Color") as string | undefined) ?? defaultColor;
  // Sidecar font/size/offset overrides fold into the dispatched props; absent overrides pass the originals through untouched (null-for-legacy).
  const fontValue = styleOf("Font");
  const sizeMul = styleOf("Size");
  const offX = styleOf("OffsetX");
  const offY = styleOf("OffsetY");
  let styled = props;
  if (
    typeof fontValue === "string" ||
    typeof sizeMul === "number" ||
    typeof offX === "number" ||
    typeof offY === "number"
  ) {
    const base = props.position ?? [0, 0, 0];
    styled = {
      ...props,
      ...(typeof fontValue === "string" ? { fontRef: parseFontString(fontValue) } : {}),
      ...(typeof sizeMul === "number" ? { fontSize: (props.fontSize ?? 0.6) * sizeMul } : {}),
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
  // Report the text + resolved size; the Scene tab derives its default scene name from the scene's largest mounted text. UI-only, an effect.
  const registeredText = props.text;
  const registeredSize = styled.fontSize ?? 0.6;
  useEffect(() => {
    if (sceneIndex === undefined || typeof registeredText !== "string" || !registeredText.trim()) {
      return;
    }
    return registerSceneText(sceneIndex, registeredText, registeredSize);
  }, [sceneIndex, registeredText, registeredSize]);
  const anim = resolveTextAnimationWithDoc(props, theme, doc);
  // Emoji clusters swap to placeholder codepoints before troika sees the string; identical text for emoji-free strings, so legacy bytes stay safe (the registry above keeps the ORIGINAL text).
  const prepared = useMemo(() => prepareEmojiText(props.text), [props.text]);
  const hasOut = anim !== null && anim.outPreset !== "none" && props.outAt !== undefined;
  const holdToMs = props.to ?? 600;
  const holdOutMs = hasOut ? props.outAt : undefined;
  useEffect(() => {
    if (sceneIndex === undefined) return;
    return registerPresentTiming(sceneIndex, { kind: "text", toMs: holdToMs, outAtMs: holdOutMs });
  }, [sceneIndex, holdToMs, holdOutMs]);
  if (anim === null || (anim.preset === "none" && !hasOut)) {
    return <LegacyHeadline {...styled} color={fill} theme={theme} prepared={prepared} />;
  }
  if (anim.granularity && anim.staggerMs > 0) {
    return (
      <StaggeredHeadline {...styled} color={fill} theme={theme} anim={anim} prepared={prepared} />
    );
  }
  return <BlockHeadline {...styled} color={fill} theme={theme} anim={anim} prepared={prepared} />;
}

/** Shared caret capture: quads only mount once the first typeset reports positions. */
type CaretInfo = { textRenderInfo?: { caretPositions?: Float32Array; blockBounds?: number[] } };

/** The v0 path, verbatim, the null-for-legacy contract for every pre-v8 project (role/color default to the original headline-face/text-token resolution, so pixels cannot move); inside an `AnimatedGroup` the group's alpha multiplies in (× 1 is fp-exact outside groups) and shine-capable groups mount the band material, both structurally inert when there is no group, so legacy bytes stay safe. Emoji quads (and their caret capture) mount only when the text actually contains emoji. */
function LegacyHeadline(
  props: AnimatedHeadlineProps & { theme: Theme; prepared: PreparedEmojiText },
) {
  const { from = 0, to = 600, position = [0, 0, 0], fontSize = 0.6, theme, prepared } = props;
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const { font, fill } = textStyle(theme, props);
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
        font={font}
        position={position}
        fontSize={fontSize}
        color={fill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        fillOpacity={alpha}
        {...layoutProps(props)}
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
        <group position={position}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        </group>
      )}
    </>
  );
}

type Bounds = readonly [number, number, number, number];

function BlockHeadline(
  props: AnimatedHeadlineProps & {
    theme: Theme;
    anim: ResolvedTextAnimation;
    prepared: PreparedEmojiText;
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
  const ownShine = anim.params.shine && anim.preset === "fade-scale";
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
      rotation={[0, sample.rotYRad, sample.rotZRad]}
      scale={sample.scale}
    >
      <Text
        font={font}
        fontSize={fontSize}
        color={fill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        fillOpacity={alpha}
        {...layoutProps(props)}
        clipRect={clipRect as unknown as [number, number, number, number] | undefined}
        outlineBlur={blurring ? sample.blurEm * fontSize : 0}
        outlineColor={fill}
        outlineOpacity={haloOpacity}
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
  props: AnimatedHeadlineProps & {
    theme: Theme;
    anim: ResolvedTextAnimation;
    prepared: PreparedEmojiText;
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
  } = props;
  const text = prepared.text;
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);
  const { localMs: rawLocalMs } = useTimeline();
  const localMs = useHeldLocalMs(rawLocalMs);
  const group = useContext(GroupAnimationContext);
  const granularity = anim.granularity ?? "word";
  // Variant flags are mount-constant (the resolved animation cannot change without a scene remount): the walk axis follows the granularity (paragraphs are vertically disjoint, so the walk keys on −Y), twist mounts the per-unit card turn, and shine stays ELEMENT-level (one band over the whole text, driven by unit 0); a shine-capable `AnimatedGroup` also mounts the shine variant, the child's OWN shine wins the single band slot, else the group band lands pre-folded.
  const axis = granularity === "paragraph" || granularity === "paragraph-group" ? "-y" : "x";
  const twisting = anim.preset === "twist-scale" || anim.outPreset === "twist-scale";
  const ownShine = anim.params.shine && anim.preset === "fade-scale";
  const shining = ownShine || group?.shineCapable === true;
  const scattering = anim.preset === "scatter-scale" || anim.outPreset === "scatter-scale";
  const holder = useMemo(
    () => createStaggerTextMaterial({ shine: shining, axis, twist: twisting, scatter: scattering }),
    [shining, axis, twisting, scattering],
  );
  useEffect(() => () => holder.dispose(), [holder]);
  const [units, setUnits] = useState<StaggerUnits | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  // The stagger spread is only known after the first typeset; the dispatcher's entry covers the base window meanwhile.
  const sceneIndex = useSceneContext()?.index;
  const spreadMs = units ? Math.max(0, units.count - 1) * anim.staggerMs : null;
  useEffect(() => {
    if (sceneIndex === undefined || spreadMs === null || spreadMs <= 0) return;
    return registerPresentTiming(sceneIndex, { kind: "text", toMs: to, staggerSpreadMs: spreadMs });
  }, [sceneIndex, spreadMs, to]);

  const timing: TextAnimTiming = { anim, from, to, outAt };
  const { font, fill } = textStyle(theme, props);
  const count = units ? Math.max(1, units.count) : 1;
  const measuring = ownShine || scattering;
  // scatter-scale's tilt drift needs each unit's centre relative to the element centre (em); the element centre comes from the measured blockBounds (anchor-centred ≈ 0).
  const elemCX = bounds ? (bounds[0] + bounds[2]) / 2 : 0;
  const elemCY = bounds ? (bounds[1] + bounds[3]) / 2 : 0;
  // Group alpha folds into every unit's alpha CPU-side (× 1 fp-exact outside groups, so the uploaded uniform floats cannot move on standing projects).
  const groupAlpha = group?.alpha ?? 1;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const ctx: ScatterSampleContext | undefined = scattering
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
  writeStaggerUniforms(holder, units, samples, fontSize);
  // Element shine under stagger: unit 0 has delay 0, so its eased progress IS the block progress; the band sweeps the measured block once during the scale-in.
  if (ownShine) writeShineUniforms(holder, bounds, samples[0].shineU);
  else if (shining) writeShineBand(holder, foldBandToChild(group, position));

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
      states.push({
        key: cluster.key,
        x: q.x,
        y: q.y,
        alpha: sample.alpha,
        scale: sample.scale,
        dx: sample.dxEm * fontSize,
        dy: sample.dyEm * fontSize,
        dz: sample.dzEm * fontSize,
        rotYRad: sample.rotYRad,
        rotYPivotX:
          twisting && units && unit < units.count
            ? (units.startX[unit] + units.endX[unit]) / 2
            : q.x,
        rotZRad: sample.rotZRad,
        coverage,
      });
    }
  }

  return (
    <>
      <Text
        font={font}
        position={position}
        fontSize={fontSize}
        color={fill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        {...layoutProps(props)}
        material={holder.material}
        onSync={(troika: CaretInfo) => {
          const info = troika.textRenderInfo;
          const caretPositions = info?.caretPositions;
          if (caretPositions) {
            setUnits(computeStaggerUnits(text, granularity, caretPositions));
            if (hasEmoji) setCarets(caretPositions);
          }
          const b = info?.blockBounds;
          if (measuring && b && b.length === 4) setBounds([b[0], b[1], b[2], b[3]]);
        }}
      >
        {text}
      </Text>
      {hasEmoji && (
        <group position={position}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        </group>
      )}
    </>
  );
}
