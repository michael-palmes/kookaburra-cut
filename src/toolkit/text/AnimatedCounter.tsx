import { Text } from "@react-three/drei";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import { shouldRenderManagedTextRole } from "../../engine/managedText";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
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
import { fontUrl, SDF_GLYPH_SIZE } from "../../theme/fonts";
import { foldBandToChild, GroupAnimationContext } from "../group/context";
import { pulse } from "../motion/pulse";
import { useBeatGrid } from "../music/useBeatGrid";
import type { EaseName, V3 } from "../types";
import { beatsInWindow, counterProgress } from "./counterProgress";
import { caretQuad, type EmojiQuadState, EmojiQuads } from "./EmojiQuads";
import { prepareEmojiText } from "./emojiText";
import { materialProp, useExactText, useExactTextBase } from "./exactText";
import { createStaggerTextMaterial, writeShineBand } from "./staggerMaterial";

export interface AnimatedCounterProps {
  from: number;
  to: number;
  /** Count-up duration, in ms (local scene time); `steps` jumps inside it, `stepsAt` replaces it. */
  durationMs: number;
  /** Formats the interpolated value for display. Defaults to a rounded integer. */
  format?: (n: number) => string;
  position?: V3;
  fontSize?: number;
  /** Where `position` sits on the number's X axis (default "center", the legacy contract). */
  anchorX?: "left" | "center" | "right";
  /** The sidecar style key this counter honours: registers the row in the Edit-text drill and applies the `textStyle.<textKey>*` overrides (Size/Color/Font/OffsetX/OffsetY/RotationDeg). */
  textKey?: string;
  /** When the count starts, in ms (scene-local; default 0). */
  startMs?: number;
  /** Scene-local ms the count LANDS on `to`, on a beat or a cut: it starts `durationMs` earlier. Wins over `startMs`; `stepsAt` ignores it. */
  hitAt?: number;
  /** An ease name shaping the count (default "linear"). With `steps` it moves when each jump falls; with `stepsAt` or `ticks` it bends how far each jump goes. */
  ease?: EaseName;
  /** Count in this many equal jumps instead of continuously, landing on `to`: a jump falls where the eased progress crosses each k/n, so the first comes after 1/n of the count (never at `startMs`), the last exactly at the end, and `ease` shifts the ones between. */
  steps?: number;
  /** "beats": one jump on every grid beat from the start of the count to its end, each with a pop, landing on `to` on the last. Counts continuously (with one log line) when the project has no grid. */
  ticks?: "beats";
  /** One jump (with a pop) at each scene-local ms, landing on `to` on the last. Wins over `ticks`, `steps` and the count window. */
  stepsAt?: readonly number[];
  /** The scale each `ticks` or `stepsAt` jump pops by (default 0.08, so 1.08 and back over 180 ms); 0 turns it off. */
  pop?: number;
  /** Where `position` sits on the number's Y axis (default "middle"). */
  anchorY?: "top" | "middle" | "bottom";
}

/** Counts from `from` to `to` over `durationMs` (from `startMs`, shaped by `ease`, in `steps` jumps when set), as a pure function of the timeline; inside an `AnimatedGroup` the group's alpha multiplies into the fill and shine-capable groups mount the band material so the sweep doesn't skip the digits, both structurally absent outside groups (standing bytes stay safe). With a `textKey` it joins the managed-text lifecycle, so it stands down under a generic takeover like every scene-owned text primitive. */
export function AnimatedCounter(props: AnimatedCounterProps) {
  const doc = useContext(SceneDocContext);
  if (props.textKey && !shouldRenderManagedTextRole(doc, "scene")) return null;
  return <AnimatedCounterRenderer {...props} />;
}

const TICK_POP_DEFAULT = 0.08;
const TICK_POP_RELEASE_MS = 180;
const TICK_POP_ATTACK_MS = 17;

let warnedBeatTicks = false;

function AnimatedCounterRenderer(rawProps: AnimatedCounterProps) {
  const grid = useBeatGrid();
  const startMs =
    rawProps.hitAt === undefined ? rawProps.startMs : rawProps.hitAt - rawProps.durationMs;
  const beats = useMemo(
    () =>
      rawProps.ticks === "beats" && grid
        ? beatsInWindow(grid, startMs ?? 0, rawProps.durationMs)
        : null,
    [rawProps.ticks, grid, startMs, rawProps.durationMs],
  );
  if (rawProps.ticks === "beats" && !grid && !warnedBeatTicks) {
    warnedBeatTicks = true;
    console.warn('[counter] ticks="beats" needs an audio.grid; counting continuously instead');
  }
  const stepsAt = rawProps.stepsAt?.length ? rawProps.stepsAt : beats?.length ? beats : undefined;
  const props: AnimatedCounterProps =
    startMs === rawProps.startMs && stepsAt === rawProps.stepsAt
      ? rawProps
      : { ...rawProps, startMs, stepsAt };
  const {
    from,
    to,
    durationMs,
    format = (n) => Math.round(n).toString(),
    position = [0, 0, 0],
    fontSize = 0.5,
    textKey,
  } = props;
  // A counter retypesets when its value changes, so it holds the frame instant across a motion blur shutter.
  const { localMs } = useTimeline(0);
  const theme = useTheme();
  const doc = useContext(SceneDocContext);
  const group = useContext(GroupAnimationContext);
  const progress = counterProgress(props, localMs);
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

  const sceneIndex = useSceneContext()?.index;
  const counts = (durationMs > 0 || !!stepsAt?.length) && from !== to;
  const countEndMs = stepsAt?.length ? Math.max(...stepsAt) : (props.startMs ?? 0) + durationMs;
  useEffect(() => {
    if (sceneIndex === undefined || !counts) return;
    return registerPresentTiming(sceneIndex, { kind: "counter", toMs: countEndMs });
  }, [sceneIndex, counts, countEndMs]);

  // Report the editable field to the registry so the Edit-text drill-in offers it (the AnimatedHeadline registration, minus copy editing: the digits stay computed).
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
  const exact = useExactText();
  const exactBase = useExactTextBase();
  const holder = useMemo(
    () => (groupShine ? createStaggerTextMaterial({ shine: true, exactText: exact }) : null),
    [groupShine, exact],
  );
  useEffect(() => () => holder?.dispose(), [holder]);
  if (holder) writeShineBand(holder, foldBandToChild(group, pos));

  // A tick's pop scales about `position`; a count without ticks has no wrapping group at all.
  const ticked = stepsAt !== undefined;
  const popScale = ticked
    ? 1 +
      (props.pop ?? TICK_POP_DEFAULT) *
        pulse(localMs, stepsAt, {
          attackMs: TICK_POP_ATTACK_MS,
          releaseMs: TICK_POP_RELEASE_MS,
        })
    : 1;

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

  const body = (
    <>
      <Text
        font={fontUrl(fontRefValue)}
        position={ticked ? ORIGIN : pos}
        fontSize={size}
        color={fill}
        anchorX={props.anchorX ?? "center"}
        anchorY={props.anchorY ?? "middle"}
        {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}
        {...(group ? { fillOpacity: group.alpha } : {})}
        {...materialProp(holder?.material ?? exactBase)}
        sdfGlyphSize={SDF_GLYPH_SIZE}
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
        <group position={ticked ? ORIGIN : pos} {...(rotZ ? { rotation: [0, 0, rotZ] as V3 } : {})}>
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={size} />
        </group>
      )}
    </>
  );
  if (!ticked) return body;
  return (
    <group position={pos} scale={popScale}>
      {body}
    </group>
  );
}

const ORIGIN: V3 = [0, 0, 0];
