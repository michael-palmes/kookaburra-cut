import { Text } from "@react-three/drei";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import { shouldRenderManagedTextRole } from "../../engine/managedText";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { useTextKeyRegistry } from "../../engine/textKeyRegistry";
import {
  resolveTokenFill,
  textStyleOffsetPosition,
  textStyleRotationRad,
  textStyleValue,
} from "../../engine/textStyleResolve";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { formatFontString, parseFontString } from "../../theme/fontRef";
import { fontUrl } from "../../theme/fonts";
import { foldBandToChild, GroupAnimationContext } from "../group/context";
import type { V3 } from "../types";
import { caretQuad, type EmojiQuadState, EmojiQuads } from "./EmojiQuads";
import { prepareEmojiText } from "./emojiText";
import { createStaggerTextMaterial, writeShineBand } from "./staggerMaterial";

export interface AnimatedCounterProps {
  from: number;
  to: number;
  /** Count-up duration, in ms (local scene time). */
  durationMs: number;
  /** Formats the interpolated value for display. Defaults to a rounded integer. */
  format?: (n: number) => string;
  position?: V3;
  fontSize?: number;
  /** Where `position` sits on the number's X axis (default "center", the legacy contract). */
  anchorX?: "left" | "center" | "right";
  /** The sidecar style key this counter honours: registers the row in the Edit-text drill and applies the `textStyle.<textKey>*` overrides (Size/Color/Font/OffsetX/OffsetY/RotationDeg). */
  textKey?: string;
}

/** Counts from `from` to `to` over `durationMs`, as a pure function of the timeline; inside an `AnimatedGroup` the group's alpha multiplies into the fill and shine-capable groups mount the band material so the sweep doesn't skip the digits, both structurally absent outside groups (standing bytes stay safe). With a `textKey` it joins the managed-text lifecycle, so it stands down under a generic takeover like every scene-owned text primitive. */
export function AnimatedCounter(props: AnimatedCounterProps) {
  const doc = useContext(SceneDocContext);
  if (props.textKey && !shouldRenderManagedTextRole(doc, "scene")) return null;
  return <AnimatedCounterRenderer {...props} />;
}

function AnimatedCounterRenderer(props: AnimatedCounterProps) {
  const {
    from,
    to,
    durationMs,
    format = (n) => Math.round(n).toString(),
    position = [0, 0, 0],
    fontSize = 0.5,
    textKey,
  } = props;
  const { localMs } = useTimeline();
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const group = useContext(GroupAnimationContext);
  const progress = durationMs <= 0 ? 1 : Math.min(1, Math.max(0, localMs / durationMs));
  const value = from + (to - from) * progress;
  // Same substitution as headlines: digits hit the fast path, but an emoji prefix/suffix in `format` output gets its quad and a stray selector never tofus.
  const display = format(value);
  const prepared = useMemo(() => prepareEmojiText(display), [display]);
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);

  // Sidecar overrides read through the shared resolvers; without a textKey every value is the coded one.
  const colourValue = textStyleValue(doc, textKey, "Color");
  const fontValue = textStyleValue(doc, textKey, "Font");
  const sizeMul = textStyleValue(doc, textKey, "Size");
  const fill = resolveTokenFill(theme, typeof colourValue === "string" ? colourValue : "accent");
  const fontRefValue =
    typeof fontValue === "string" ? parseFontString(fontValue) : theme.typography.body;
  const size = typeof sizeMul === "number" ? fontSize * sizeMul : fontSize;
  const pos = textStyleOffsetPosition(doc, textKey, position);
  const rotZ = textStyleRotationRad(doc, textKey);

  // Report the editable field to the registry so the Edit-text drill-in offers it (the AnimatedHeadline registration, minus copy editing: the digits stay computed).
  const sceneIndex = useSceneContext()?.index;
  const mountId = useId();
  const finalText = format(to);
  const registeredFont = formatFontString(fontRefValue);
  const registeredColor = typeof colourValue === "string" ? colourValue : "accent";
  const offX = textStyleValue(doc, textKey, "OffsetX");
  const offY = textStyleValue(doc, textKey, "OffsetY");
  const rotDeg = textStyleValue(doc, textKey, "RotationDeg");
  useLayoutEffect(() => {
    if (sceneIndex === undefined || !textKey || doc?.managedText !== undefined) return;
    useTextKeyRegistry.getState().register(sceneIndex, textKey, mountId, {
      colorDefault: "accent",
      styleCapable: true,
      resolvedText: finalText,
      // A single-line number: LineHeight never applies, so the drill hides Spacing.
      inertStyleControls: ["spacing"],
      style: {
        color: registeredColor,
        font: registeredFont,
        size: typeof sizeMul === "number" ? sizeMul : 1,
        offsetX: typeof offX === "number" ? offX : 0,
        offsetY: typeof offY === "number" ? offY : 0,
        rotationDeg: typeof rotDeg === "number" ? rotDeg : 0,
      },
    });
    return () => useTextKeyRegistry.getState().unregister(sceneIndex, textKey, mountId);
  }, [
    sceneIndex,
    textKey,
    mountId,
    doc?.managedText,
    finalText,
    registeredColor,
    registeredFont,
    sizeMul,
    offX,
    offY,
    rotDeg,
  ]);

  const groupShine = group?.shineCapable === true;
  const holder = useMemo(
    () => (groupShine ? createStaggerTextMaterial({ shine: true }) : null),
    [groupShine],
  );
  useEffect(() => () => holder?.dispose(), [holder]);
  if (holder) writeShineBand(holder, foldBandToChild(group, pos));

  const alpha = group?.alpha ?? 1;
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
        font={fontUrl(fontRefValue)}
        position={pos}
        fontSize={size}
        color={fill}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
        {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
        {...(group ? { fillOpacity: group.alpha } : {})}
        {...(holder ? { material: holder.material } : {})}
        onSync={
          hasEmoji
            ? (troika: { textRenderInfo?: { caretPositions?: Float32Array } }) => {
                const c = troika.textRenderInfo?.caretPositions;
                if (c) setCarets(c);
              }
            : undefined
        }
      >
        {prepared.text}
      </Text>
      {hasEmoji && (
        <group position={pos} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={size} />
        </group>
      )}
    </>
  );
}
