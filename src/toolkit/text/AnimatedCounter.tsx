import { Text } from "@react-three/drei";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
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
}

/** Counts from `from` to `to` over `durationMs`, as a pure function of the timeline; inside an `AnimatedGroup` the group's alpha multiplies into the fill and shine-capable groups mount the band material so the sweep doesn't skip the digits, both structurally absent outside groups (standing bytes stay safe). */
export function AnimatedCounter(props: AnimatedCounterProps) {
  const {
    from,
    to,
    durationMs,
    format = (n) => Math.round(n).toString(),
    position = [0, 0, 0],
    fontSize = 0.5,
  } = props;
  const { localMs } = useTimeline();
  const theme = useTheme();
  const group = useContext(GroupAnimationContext);
  const progress = durationMs <= 0 ? 1 : Math.min(1, Math.max(0, localMs / durationMs));
  const value = from + (to - from) * progress;
  // Same substitution as headlines: digits hit the fast path, but an emoji prefix/suffix in `format` output gets its quad and a stray selector never tofus.
  const display = format(value);
  const prepared = useMemo(() => prepareEmojiText(display), [display]);
  const hasEmoji = prepared.clusters.length > 0;
  const [carets, setCarets] = useState<Float32Array | null>(null);

  const groupShine = group?.shineCapable === true;
  const holder = useMemo(
    () => (groupShine ? createStaggerTextMaterial({ shine: true }) : null),
    [groupShine],
  );
  useEffect(() => () => holder?.dispose(), [holder]);
  if (holder) writeShineBand(holder, foldBandToChild(group, position));

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
        font={fontUrl(theme.typography.body)}
        position={position}
        fontSize={fontSize}
        color={theme.colors.accent}
        anchorX={props.anchorX ?? "center"}
        anchorY="middle"
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
        <group position={position}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        </group>
      )}
    </>
  );
}
