import { useEffect, useId, useRef } from "react";
import type { Group } from "three";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { FrameChip } from "./FrameChip";
import { FrameDecoration } from "./FrameDecoration";
import { FrameIcon } from "./FrameIcon";
import { useFormat } from "./format";
import { framePanelLayout } from "./framePanelLayout";
import { registerFramePanel, unregisterFramePanel } from "./framePanelRegistry";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** Title size as a fraction of the column's width, clamped by its height (the title-slide size, before the fit-to-column scale). */
const TITLE_WIDTH_FRACTION = 0.2;
const TITLE_HEIGHT_FRACTION = 0.18;
/** Troika's default line height, so a wrapped block's budget is `lines x this x size`. */
const LINE_HEIGHT = 1.2;
/** Subtitle line budget so a wrapped subtitle never collides with what follows (troika wraps async, so height is budgeted, not measured). The title's budget is estimated from its length instead, since titles vary the most. */
const SUBTITLE_LINE_BUDGET = 2;
/** Rough average glyph advance (em) for estimating a title's wrapped line count, and the cap on it; titles are short by design (the reference slides run to two words), so the fit scale absorbs any longer one. */
const AVG_CHAR_ADVANCE = 0.5;
const TITLE_MAX_LINES = 4;
/** Icon edge as a multiple of the title height, and its gap above the title in title-heights. */
const ICON_SIZE = 1.25;
const ICON_GAP = 0.4;
/** Subtitle and bullet sizes as a fraction of the title (bullets read as small body copy, well under the headline, like the reference slides). */
const SUBTITLE_OF_TITLE = 0.44;
const BULLET_OF_TITLE = 0.32;
/** Gap below the title before the subtitle, in title-heights. */
const TITLE_GAP = 0.35;
/** Extra gap between bullet lines, and the chip's gap above the bullets, in bullet-heights. */
const BULLET_LINE_GAP = 0.6;
const CHIP_GAP = 1.4;
/** Chip pill height as a fraction of the frame height (about 64px on a 1080p reference frame). */
const CHIP_HEIGHT_FRAC = 0.059;
/** The body (bullets + chip) stacks directly under the header, this gap below it (title-heights). */
const HEADER_BODY_GAP = 0.5;
/** Nudges the whole editorial column (title/subtitle/bullets/chip, not the decorations) left, as a fraction of the column width. */
const CONTENT_LEFT_SHIFT = 0.06;

function splitBullets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Estimates how many lines a title wraps to at `size` in `width` world units, so its vertical budget adapts to length (troika wraps async, so this cannot be measured at layout time). Simulates troika's greedy word-wrap (whole words per line) rather than dividing by characters, so a two long-word title like "Repository Standard" reads as two lines, not three. */
function estimateTitleLines(text: string, size: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * AVG_CHAR_ADVANCE)));
  let lines = 1;
  let filled = 0;
  for (const word of text.trim().split(/\s+/)) {
    if (filled === 0) filled = word.length;
    else if (filled + 1 + word.length <= perLine) filled += 1 + word.length;
    else {
      lines++;
      filled = word.length;
    }
  }
  return Math.min(TITLE_MAX_LINES, lines);
}

/** The overlay panel's editorial content: the header (icon + title + subtitle) anchors to the column top, and the body (bullets, then chip) stacks directly beneath it, so the lower panel stays free for a breakout illustration. Every block's height is budgeted (title from a length estimate, subtitle at a 2-line worst case) and the stack scales to fit the column, so the header and body never overlap. Reads the sidecar text DIRECTLY (like `TextFallback`) so it never registers as a text-key consumer, and lays out against the FULL frame's panel region since it mounts outside the cutout's `FormatContext`. */
function PanelContent({ frame }: { frame: FrameSpec }) {
  const doc = useSceneDoc();
  const format = useFormat();
  const title = doc?.text?.title ?? "";
  const subtitle = doc?.text?.subtitle ?? "";
  const bullets = splitBullets(doc?.text?.bullets);
  const decorations = frame.decorations ?? [];
  const hasText = title.trim() || subtitle.trim() || bullets.length > 0;
  if (!hasText && !frame.icon && !frame.chip && decorations.length === 0) return null;

  const col = framePanelLayout(format, frame);
  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const baseSub = baseTitle * SUBTITLE_OF_TITLE;
  const baseBullet = baseTitle * BULLET_OF_TITLE;
  const baseIcon = baseTitle * ICON_SIZE;
  const baseChip = CHIP_HEIGHT_FRAC * format.frame.height;

  // One fit scale from worst-case budgets keeps the top-anchored header and the body apart.
  const iconBudget = frame.icon ? baseIcon + ICON_GAP * baseTitle : 0;
  const titleLines = title.trim() ? estimateTitleLines(title, baseTitle, col.width) : 0;
  const titleBudget = titleLines * LINE_HEIGHT * baseTitle;
  const titleGap = title.trim() && subtitle.trim() ? TITLE_GAP * baseTitle : 0;
  const subBudget = subtitle.trim() ? SUBTITLE_LINE_BUDGET * LINE_HEIGHT * baseSub : 0;
  const headerBudget = iconBudget + titleBudget + titleGap + subBudget;
  const bulletsBudget =
    bullets.length > 0
      ? (bullets.length - 1) * (LINE_HEIGHT + BULLET_LINE_GAP) * baseBullet +
        LINE_HEIGHT * baseBullet
      : 0;
  const chipBudget = frame.chip ? (bullets.length > 0 ? CHIP_GAP * baseBullet : 0) + baseChip : 0;
  const stack = headerBudget + HEADER_BODY_GAP * baseTitle + bulletsBudget + chipBudget;
  const fit = stack > col.height ? col.height / stack : 1;

  const titleSize = baseTitle * fit;
  const subtitleSize = baseSub * fit;
  const bulletSize = baseBullet * fit;
  const iconSize = baseIcon * fit;
  const chipHeight = baseChip * fit;
  // Text alignment: the anchor x sits at the column's left (nudged), centre or right edge, with the
  // headlines and chip anchored to match. Default "left" reproduces the original contentX exactly.
  const align = frame.textAlign ?? "left";
  const alignX =
    align === "center"
      ? col.left + col.width / 2
      : align === "right"
        ? col.left + col.width
        : col.left - CONTENT_LEFT_SHIFT * col.width;
  const chipAnchor = align === "center" ? 0.5 : align === "right" ? 1 : 0;
  const at = (worldY: number): V3 => [alignX, worldY, 0];

  // Header, top-anchored.
  let y = col.top;
  const iconTop = y;
  if (frame.icon) y -= iconSize + ICON_GAP * titleSize;
  const titleTop = y;
  if (title.trim()) y -= titleLines * LINE_HEIGHT * titleSize;
  if (title.trim() && subtitle.trim()) y -= TITLE_GAP * titleSize;
  const subtitleTop = y;
  if (subtitle.trim()) y -= SUBTITLE_LINE_BUDGET * LINE_HEIGHT * subtitleSize;
  const headerBottom = y;

  // Body (bullets + chip): stacked directly under the header, kept inside the bottom edge.
  const bulletAdv = (LINE_HEIGHT + BULLET_LINE_GAP) * bulletSize;
  const bulletsHeight =
    bullets.length > 0 ? (bullets.length - 1) * bulletAdv + LINE_HEIGHT * bulletSize : 0;
  const chipGap = bullets.length > 0 && frame.chip ? CHIP_GAP * bulletSize : 0;
  const bodyHeight = bulletsHeight + chipGap + (frame.chip ? chipHeight : 0);
  let bodyTop = headerBottom - HEADER_BODY_GAP * titleSize;
  bodyTop = Math.max(bodyTop, col.bottom + bodyHeight);
  const chipBottom = bodyTop - bulletsHeight - chipGap - chipHeight;

  return (
    <>
      {frame.icon && (
        <FrameIcon
          icon={frame.icon}
          position={at(iconTop)}
          size={iconSize}
          from={150}
          to={700}
          anchorX={align}
        />
      )}
      {title.trim() && (
        <AnimatedHeadline
          text={title}
          from={200}
          to={900}
          position={at(titleTop)}
          fontSize={titleSize}
          anchorX={align}
          anchorY="top"
          textAlign={align}
          maxWidth={col.width}
        />
      )}
      {subtitle.trim() && (
        <AnimatedHeadline
          text={subtitle}
          from={350}
          to={1050}
          position={at(subtitleTop)}
          fontSize={subtitleSize}
          face="body"
          color="muted"
          anchorX={align}
          anchorY="top"
          textAlign={align}
          maxWidth={col.width}
        />
      )}
      {bullets.map((line, i) => (
        <AnimatedHeadline
          key={line}
          text={`•  ${line}`}
          from={500 + i * 140}
          to={1000 + i * 140}
          position={at(bodyTop - i * bulletAdv)}
          fontSize={bulletSize}
          face="body"
          anchorX={align}
          anchorY="top"
          textAlign={align}
          maxWidth={col.width}
        />
      ))}
      {frame.chip && (
        <FrameChip
          chip={frame.chip}
          position={[alignX, chipBottom, 0]}
          height={chipHeight}
          from={700}
          to={1300}
          anchorFrac={chipAnchor}
        />
      )}
      {decorations.map((decoration, i) => (
        <FrameDecoration
          key={decoration.id}
          decoration={decoration}
          format={format}
          from={250}
          to={950}
          order={i}
        />
      ))}
    </>
  );
}

/** Hosts one scene's overlay panel content, mounted in App.tsx as a SIBLING of the scene hosts (never a child), so it lays out against the full frame, not the cutout, and the compositor can draw it over the composited slide. Provides the scene contexts it needs (time, doc, theme) but deliberately NO `FormatContext`, so `useFormat()` resolves the real frame; registers its group so the compositor can gate it to the active scene. */
export function FramePanel({
  index,
  startMs,
  durationMs,
  doc,
  theme,
  frame,
}: {
  index: number;
  startMs: number;
  durationMs: number;
  doc?: SceneDoc;
  theme?: Theme;
  frame: FrameSpec;
}) {
  const key = useId();
  const groupRef = useRef<Group>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    registerFramePanel(key, { index, group });
    return () => unregisterFramePanel(key);
  }, [key, index]);

  return (
    <SceneContext.Provider value={{ index, startMs, durationMs }}>
      <SceneDocContext.Provider value={doc ?? null}>
        <SceneThemeContext.Provider value={theme ?? null}>
          <group ref={groupRef} visible={false}>
            <PanelContent frame={frame} />
          </group>
        </SceneThemeContext.Provider>
      </SceneDocContext.Provider>
    </SceneContext.Provider>
  );
}
