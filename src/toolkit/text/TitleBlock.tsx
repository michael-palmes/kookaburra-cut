import { useContext } from "react";
import { useFormat } from "../../engine/format";
import { SceneTextClaimedContext, useSceneContext } from "../../engine/sceneContext";
import { useSceneDoc } from "../../engine/sceneDoc";
import type { SceneTextAlign } from "../../engine/sceneDocSchema";
import { useSceneConsumesAnyTextKey } from "../../engine/textKeyRegistry";
import { useTheme } from "../../theme";
import type { V3 } from "../types";
import { AnimatedHeadline } from "./AnimatedHeadline";

/** How many modular-scale steps the subtitle sits below the title (matches the hand-authored .56/.22 convention at scale 1.25). */
const SUBTITLE_SCALE_STEPS = 4;
/** Subtitle reveal delay behind the title, ms (the house stagger convention). */
const SUBTITLE_DELAY_MS = 350;

export interface TitleBlockProps {
  title: string;
  /** Empty or absent recentres the title (the natural single-line format). */
  subtitle?: string;
  /** Beats the sidecar's `textLayout.align`; the block anchors against the safe area. */
  align?: SceneTextAlign;
  /** Title reveal window (scene-local ms); the subtitle rides 350ms behind. */
  from?: number;
  to?: number;
  /** Title size in world units (portrait 0.34 / landscape 0.56); the subtitle derives via `theme.typography.scale`. */
  fontSize?: number;
  /** Offset added after alignment (world units). */
  position?: V3;
  /** Wrap width in world units for both lines; unset means no wrapping. */
  maxWidth?: number;
  /** Title fill: a token or raw hex; beats the sidecar's `textStyle.titleColor`. */
  titleColor?: "text" | "muted" | "accent" | (string & {});
  /** Subtitle fill token or raw hex (default "muted"); beats the sidecar's `textStyle.subtitleColor`. */
  subtitleColor?: "text" | "muted" | "accent" | (string & {});
  /** Subtitle reveal delay behind the title, ms (default 350). */
  subtitleDelayMs?: number;
}

/** Title + optional subtitle with theme-scale sizing and safe-area alignment: the standard top-of-scene text block. Alignment resolves prop → sidecar `textLayout.align` → centre, so the inspector can steer scenes that don't hard-code it. */
export function TitleBlock(props: TitleBlockProps) {
  const {
    title,
    subtitle,
    from = 200,
    to = 900,
    position = [0, 0, 0],
    subtitleDelayMs = SUBTITLE_DELAY_MS,
  } = props;
  const theme = useTheme();
  const format = useFormat();
  const doc = useSceneDoc();
  const claimed = useContext(SceneTextClaimedContext);
  const portrait = format.aspect < 1;
  // The overlay panel renders the headline instead; suppress the in-world one.
  if (claimed) return null;
  const align = props.align ?? doc?.textLayout?.align ?? "center";
  const titleSize = props.fontSize ?? (portrait ? 0.34 : 0.56);
  const subtitleSize = titleSize / theme.typography.scale ** SUBTITLE_SCALE_STEPS;
  const hasSubtitle = typeof subtitle === "string" && subtitle.trim().length > 0;

  const anchorX =
    align === "left"
      ? -format.frame.width / 2 + format.safe.left
      : align === "right"
        ? format.frame.width / 2 - format.safe.right
        : 0;
  const titleY = hasSubtitle ? (portrait ? 0.55 : 0.35) : 0;
  const subtitleY = portrait ? -0.28 : -0.42;
  const at = (y: number): V3 => [anchorX + position[0], y + position[1], position[2]];

  return (
    <>
      <AnimatedHeadline
        text={title}
        from={from}
        to={to}
        position={at(titleY)}
        fontSize={titleSize}
        color={props.titleColor}
        textKey="title"
        anchorX={align}
        textAlign={align}
        maxWidth={props.maxWidth}
      />
      {hasSubtitle && (
        <AnimatedHeadline
          text={subtitle}
          from={from + subtitleDelayMs}
          to={to + subtitleDelayMs}
          position={at(subtitleY)}
          fontSize={subtitleSize}
          face="body"
          color={props.subtitleColor}
          textKey="subtitle"
          defaultColor="muted"
          anchorX={align}
          textAlign={align}
          maxWidth={props.maxWidth}
        />
      )}
    </>
  );
}

/** The sidecar text keys the fallback owns; the inspector's Add text seeds these. */
export const FALLBACK_TEXT_KEYS = ["title", "subtitle"] as const;

/** Host-side title/subtitle for scenes whose TSX never wires `useSceneText` for these keys (mounted by App's SceneHost, never scene TSX): reads the doc directly so it can't register as a consumer itself. */
export function TextFallback() {
  const doc = useSceneDoc();
  const sceneIndex = useSceneContext()?.index;
  const consumed = useSceneConsumesAnyTextKey(sceneIndex, FALLBACK_TEXT_KEYS);
  const title = doc?.text?.title ?? "";
  if (consumed || !title.trim()) return null;
  return <TitleBlock title={title} subtitle={doc?.text?.subtitle ?? ""} />;
}
