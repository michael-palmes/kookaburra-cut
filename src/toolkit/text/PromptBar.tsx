import { Text } from "@react-three/drei";
import { useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Shape } from "three";
import { useFormat } from "../../engine/format";
import { useHeldLocalMs } from "../../engine/presentHold";
import { registerPresentTiming } from "../../engine/presentTimingRegistry";
import { SceneDocContext, useSceneContext } from "../../engine/sceneContext";
import { reportTextDerivedPending } from "../../engine/textDerivedState";
import { resolveTokenFill, textStyleValue } from "../../engine/textStyleResolve";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import { SDF_GLYPH_SIZE } from "../../theme/fonts";
import { liftColour } from "../colour";
import { GroupAnimationContext } from "../group/context";
import { RoundedRect } from "../shapes/RoundedRect";
import type { V3 } from "../types";
import { prepareDisplayText } from "./displayText";
import {
  caretQuad,
  EMOJI_QUAD_EM,
  type EmojiQuadState,
  EmojiQuads,
  sweepCoverage,
} from "./EmojiQuads";
import { materialProp, useExactTextBase } from "./exactText";
import { resolveHeadlineType } from "./headlineType";
import {
  DEFAULT_START_SCALE,
  type ResolvedTextAnimation,
  typewriterCount,
  typewriterStops,
} from "./presets";

// ── Contract constants (changing any re-renders every PromptBar) ──
/** Typing pace when no `to` is given, ms per keystroke. */
export const PROMPT_CHAR_MS = 45;
/** Caret blink half-period once typing is idle, ms (on, then off). */
export const PROMPT_CARET_BLINK_MS = 530;
/** Bar defaults: height in world units, width as a fraction of the frame width, text as a fraction of the height. */
export const PROMPT_HEIGHT = 0.62;
export const PROMPT_WIDTH_FRAC = 0.62;
export const PROMPT_TEXT_FRAC = 0.4;
/** Surface lift of the bar fill and its rim toward the text colour. */
export const PROMPT_FILL_LIFT = 0.08;
export const PROMPT_RIM_LIFT = 0.2;

export interface PromptBarProps {
  /** The prompt, typed in one keystroke at a time (emphasis markup is stripped and drawn plain). */
  text: string;
  /** Sidecar style key: `textStyle.<key>Color`, `Font` and `Size` apply. */
  textKey?: string;
  /** Typing starts, ms (scene-local; default 0). */
  from?: number;
  /** Typing ends, ms (default `from` + 45 ms per keystroke). */
  to?: number;
  position?: V3;
  /** Bar width, world units (default 0.62 × the frame width). */
  width?: number;
  /** Bar height, world units (default 0.62). */
  height?: number;
  /** Text size (default 0.4 × the height). */
  fontSize?: number;
  /** Which theme face types the prompt (default "body"). */
  face?: "headline" | "body";
  /** Draw the send button (default true). */
  send?: boolean;
  /** Draw the caret (default true). */
  caret?: boolean;
}

const TYPEWRITER: ResolvedTextAnimation = {
  preset: "typewriter",
  outPreset: "none",
  ease: "linear",
  staggerMs: 0,
  granularity: null,
  params: { startScale: DEFAULT_START_SCALE, shine: false, twistDir: 1 },
};

type CaretInfo = { textRenderInfo?: { caretPositions?: Float32Array } };

/** The send icon: an up arrow (stem plus head) in a unit box centred on the origin. */
function sendArrow(): Shape {
  const s = new Shape();
  s.moveTo(-0.09, -0.32);
  s.lineTo(0.09, -0.32);
  s.lineTo(0.09, 0.02);
  s.lineTo(0.27, 0.02);
  s.lineTo(0, 0.32);
  s.lineTo(-0.27, 0.02);
  s.lineTo(-0.09, 0.02);
  s.closePath();
  return s;
}

/** A chat-style prompt bar: a rounded bar whose text types in one keystroke at a time (the typewriter preset's pace, revealed by a clip rect so the line scrolls like a real input once it outgrows the bar), a caret that blinks on the timeline once typing is idle, and a procedural send button. Theme tokens only; a pure function of the clock. */
export function PromptBar(props: PromptBarProps) {
  const {
    text: raw,
    textKey,
    from = 0,
    position = [0, 0, 0],
    face = "body",
    send = true,
    caret = true,
  } = props;
  const theme = useTheme();
  const format = useFormat();
  const doc = useContext(SceneDocContext);
  const group = useContext(GroupAnimationContext);
  const localMs = useHeldLocalMs(useTimeline().localMs);
  const prepared = useMemo(() => prepareDisplayText(raw), [raw]);
  const text = prepared.text;
  const stops = useMemo(() => typewriterStops(text), [text]);
  const to = props.to ?? from + stops.length * PROMPT_CHAR_MS;
  const height = props.height ?? PROMPT_HEIGHT;
  const width = props.width ?? format.frame.width * PROMPT_WIDTH_FRAC;
  const type = resolveHeadlineType(theme, doc, {
    textKey,
    face,
    fontSize: props.fontSize ?? height * PROMPT_TEXT_FRAC,
  });
  const fontSize = type.fontSize;
  const colourValue = textStyleValue(doc, textKey, "Color");
  const fill = resolveTokenFill(theme, typeof colourValue === "string" ? colourValue : "text");
  const alpha = group?.alpha ?? 1;
  const exactBase = useExactTextBase();
  const [carets, setCarets] = useState<Float32Array | null>(null);
  const pending = carets === null && text.length > 0;
  useLayoutEffect(() => (pending ? reportTextDerivedPending() : undefined), [pending]);
  const sceneIndex = useSceneContext()?.index;
  useEffect(() => {
    if (sceneIndex === undefined) return;
    return registerPresentTiming(sceneIndex, { kind: "text", toMs: to });
  }, [sceneIndex, to]);

  const pad = height * 0.42;
  const buttonD = height * 0.72;
  const textLeft = -width / 2 + pad;
  const textRight = send
    ? width / 2 - (height - buttonD) / 2 - buttonD - pad * 0.5
    : width / 2 - pad;
  const visible = Math.max(0, textRight - textLeft);
  const n = typewriterCount({ anim: TYPEWRITER, from, to }, localMs, stops.length);
  // The head: the last shown keystroke's right edge in the text's own layout space.
  let headX = 0;
  if (carets && n > 0 && stops.length > 0) {
    const c = stops[Math.min(n, stops.length) - 1];
    const last = c + ((text.codePointAt(c) ?? 0) > 0xffff ? 1 : 0);
    for (let i = c; i <= last && i * 4 + 1 < carets.length; i++) {
      headX = Math.max(headX, carets[i * 4], carets[i * 4 + 1]);
    }
  }
  const scroll = Math.max(0, headX - visible);
  const clipRect: [number, number, number, number] =
    n <= 0 || !carets
      ? [0, 0, 0, 0]
      : [scroll, -fontSize * 2, Math.min(headX, scroll + visible), fontSize * 2];
  const typing = localMs > from && n < stops.length;
  const blinkOn = Math.floor(Math.max(0, localMs) / PROMPT_CARET_BLINK_MS) % 2 === 0;
  const showCaret = caret && (typing || blinkOn);
  const caretX = textLeft - scroll + headX + fontSize * 0.06;

  const states: EmojiQuadState[] = [];
  if (carets && prepared.clusters.length > 0) {
    const halfW = (EMOJI_QUAD_EM * fontSize) / 2;
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
        coverage: n <= 0 ? 0 : sweepCoverage(q.x, halfW, clipRect[0], clipRect[2]),
      });
    }
  }

  const arrow = useMemo(sendArrow, []);
  const barFill = liftColour(theme.colors.background, theme.colors.text, PROMPT_FILL_LIFT);
  const rim = liftColour(theme.colors.background, theme.colors.text, PROMPT_RIM_LIFT);
  const z = height * 0.01;

  return (
    <group position={position}>
      <RoundedRect
        width={width}
        height={height}
        radius={height / 2}
        color={barFill}
        strokeWidth={height * 0.03}
        strokeColor={rim}
      />
      <group position={[textLeft - scroll, 0, z]}>
        <Text
          font={type.font}
          fontSize={fontSize}
          color={fill}
          anchorX="left"
          anchorY="middle"
          fillOpacity={alpha}
          clipRect={clipRect}
          {...materialProp(exactBase)}
          sdfGlyphSize={SDF_GLYPH_SIZE}
          onSync={(troika: CaretInfo) => {
            const c = troika.textRenderInfo?.caretPositions;
            if (c) setCarets(c);
          }}
        >
          {text}
        </Text>
        {states.length > 0 && (
          <EmojiQuads clusters={prepared.clusters} states={states} fontSize={fontSize} />
        )}
      </group>
      {showCaret && (
        <mesh position={[caretX, 0, z * 2]}>
          <planeGeometry args={[fontSize * 0.07, fontSize * 1.2]} />
          <meshBasicMaterial
            color={theme.colors.accent}
            transparent
            opacity={alpha}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
      )}
      {send && (
        <group position={[width / 2 - height / 2, 0, z]}>
          <RoundedRect
            width={buttonD}
            height={buttonD}
            radius={buttonD / 2}
            color={theme.colors.accent}
            opacity={n > 0 ? 1 : 0.4}
          />
          <mesh position={[0, 0, z]} scale={[buttonD * 0.8, buttonD * 0.8, 1]}>
            <shapeGeometry args={[arrow]} />
            <meshBasicMaterial
              color={theme.colors.background}
              transparent
              opacity={alpha * (n > 0 ? 1 : 0.4)}
              toneMapped={false}
              depthWrite={false}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}
