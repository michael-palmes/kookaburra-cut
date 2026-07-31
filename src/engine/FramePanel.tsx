import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import type { Group } from "three";
import { useTheme } from "../theme";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { FrameChip } from "./FrameChip";
import { FrameDecoration } from "./FrameDecoration";
import { FrameIcon } from "./FrameIcon";
import { useFormat } from "./format";
import { framePanelLayout, frameTextAlign } from "./framePanelLayout";
import {
  BULLET_LINE_GAP,
  BULLET_OF_TITLE,
  CHIP_GAP,
  CHIP_HEIGHT_FRAC,
  HEADER_BODY_GAP,
  ICON_GAP,
  ICON_SIZE,
  panelMeasureVersion,
  requestPanelTextMeasure,
  SUBTITLE_OF_TITLE,
  solvePanelLayout,
  splitBullets,
  subscribePanelMeasures,
  TITLE_GAP,
  TITLE_HEIGHT_FRACTION,
  TITLE_WIDTH_FRACTION,
} from "./framePanelMeasure";
import { registerFramePanel, unregisterFramePanel } from "./framePanelRegistry";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** Nudges the whole editorial column (title/subtitle/bullets/chip, not the decorations) left, as a fraction of the column width. */
const CONTENT_LEFT_SHIFT = 0.06;

/** The overlay panel's editorial content: the header (icon + title + subtitle) anchors to the column top, and the body (bullets, then chip) stacks directly beneath it, so the lower panel stays free for a breakout illustration. Title, subtitle and per-bullet heights come from `solvePanelLayout`'s measured fixpoint (the wrap estimate standing in until measurements land), so reserved and rendered space agree and wrapped bullets never overlap their neighbours. Reads the sidecar text directly, and its headlines carry `textKey`s so the sidecar's `textStyle.<key>*` overrides (font/colour/size) apply and the Edit-text drill-in offers them. Lays out against the FULL frame's panel region since it mounts outside the cutout's `FormatContext`. */
function PanelContent({ frame }: { frame: FrameSpec }) {
  const doc = useSceneDoc();
  const format = useFormat();
  const theme = useTheme();
  // When the frame doesn't claim the scene text, the in-world headline shows instead, so the panel omits it.
  const claimed = frame.claimsSceneText !== false;
  const title = claimed ? (doc?.text?.title ?? "") : "";
  const subtitle = claimed ? (doc?.text?.subtitle ?? "") : "";
  const bullets = claimed ? splitBullets(doc?.text?.bullets) : [];
  const decorations = frame.decorations ?? [];
  // The measured fixpoint: the cache fills async (pre-warmed by the export preamble); each landing bumps the store, re-solving until nothing is pending.
  const measureTick = useSyncExternalStore(
    subscribePanelMeasures,
    panelMeasureVersion,
    panelMeasureVersion,
  );
  const solution = useMemo(() => {
    void measureTick;
    return solvePanelLayout(format, frame, doc ?? undefined, theme);
  }, [format, frame, doc, theme, measureTick]);
  useEffect(() => {
    for (const spec of solution.pending) requestPanelTextMeasure(spec);
  }, [solution]);
  const hasText = title.trim() || subtitle.trim() || bullets.length > 0;
  if (!hasText && !frame.icon && !frame.chip && decorations.length === 0) return null;

  const col = framePanelLayout(format, frame);
  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const { fit, titleH, subH, bulletHeights } = solution;

  const titleSize = baseTitle * fit;
  const subtitleSize = baseTitle * SUBTITLE_OF_TITLE * fit;
  const bulletSize = baseTitle * BULLET_OF_TITLE * fit;
  const iconSize = baseTitle * ICON_SIZE * fit;
  const chipHeight = CHIP_HEIGHT_FRAC * format.frame.height * fit;
  // Text alignment: the anchor x sits at the column's left (nudged), centre or right edge, with the
  // headlines and chip anchored to match. Default "left" reproduces the original contentX exactly.
  const align = frameTextAlign(frame);
  const alignX =
    align === "center"
      ? col.left + col.width / 2
      : align === "right"
        ? col.left + col.width
        : col.left - CONTENT_LEFT_SHIFT * col.width;
  const chipAnchor = align === "center" ? 0.5 : align === "right" ? 1 : 0;
  const at = (worldY: number): V3 => [alignX, worldY, 0];

  // Header, top-anchored; titleH/subH are the solved heights at the fitted size.
  let y = col.top;
  const iconTop = y;
  if (frame.icon) y -= iconSize + ICON_GAP * titleSize;
  const titleTop = y;
  if (title.trim()) y -= titleH;
  if (title.trim() && subtitle.trim()) y -= TITLE_GAP * titleSize;
  const subtitleTop = y;
  if (subtitle.trim()) y -= subH;
  const headerBottom = y;

  // Body (bullets + chip): stacked directly under the header, kept inside the bottom edge; each bullet advances by its own measured height, so wrapped lines push the rest down.
  const bulletGap = BULLET_LINE_GAP * bulletSize;
  const bulletsHeight =
    bulletHeights.length > 0
      ? bulletHeights.reduce((sum, h) => sum + h, 0) + (bulletHeights.length - 1) * bulletGap
      : 0;
  const bulletTops: number[] = [];
  const chipGap = bullets.length > 0 && frame.chip ? CHIP_GAP * bulletSize : 0;
  const bodyHeight = bulletsHeight + chipGap + (frame.chip ? chipHeight : 0);
  let bodyTop = headerBottom - HEADER_BODY_GAP * titleSize;
  bodyTop = Math.max(bodyTop, col.bottom + bodyHeight);
  {
    let cursor = bodyTop;
    for (const h of bulletHeights) {
      bulletTops.push(cursor);
      cursor -= h + bulletGap;
    }
  }
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
          textKey="title"
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
          textKey="subtitle"
          from={350}
          to={1050}
          position={at(subtitleTop)}
          fontSize={subtitleSize}
          face="body"
          defaultColor="muted"
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
          textKey="bullets"
          from={500 + i * 140}
          to={1000 + i * 140}
          position={at(bulletTops[i] ?? bodyTop)}
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
