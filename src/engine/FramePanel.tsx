import { Fragment, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import type { Group } from "three";
import { useTheme } from "../theme";
import type { Theme } from "../theme/tokens";
import { MountedChart } from "../toolkit/chart/Chart";
import type { FrameSpec } from "../toolkit/frame/types";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { FrameChip } from "./FrameChip";
import { FrameDecoration } from "./FrameDecoration";
import { FrameIcon } from "./FrameIcon";
import { useFormat } from "./format";
import {
  framePanelChartReplaces,
  framePanelChartSlot,
  framePanelLayout,
  frameTextAlign,
} from "./framePanelLayout";
import {
  BULLET_GAP,
  BULLET_LINE_GAP,
  BULLET_MARKER,
  BULLET_OF_TITLE,
  CHIP_GAP,
  CHIP_HEIGHT_FRAC,
  HEADER_BODY_GAP,
  headerIconScale,
  ICON_GAP,
  ICON_SIZE,
  ICON_TEXT_KEY,
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
import { type ResolvedChart, resolveChart } from "./sceneChart";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** Nudges the whole editorial column (title/subtitle/bullets/chip, not the decorations) left, as a fraction of the column width. */
const CONTENT_LEFT_SHIFT = 0.06;

/** The panel's chart: the scene's own block (resolved exactly as any other mount reads it, so the build-in, the data track and the appearance preset are the same chart), taken only when it asks for the panel mount, then given the panel's label defaults where the author left them unset. A legend rarely earns its space in a column, and a single series reads better with its values printed. Resolved directly rather than through `useSceneChart` so the panel never registers as the scene's chart consumer. */
function panelChart(doc: SceneDoc | null | undefined): ResolvedChart | null {
  const chart = resolveChart(doc ?? undefined);
  if (chart?.mount !== "panel") return null;
  const authored = doc?.chart?.labels;
  return {
    ...chart,
    labels: {
      legend: { ...chart.labels.legend, visible: authored?.legend?.visible ?? false },
      values: {
        ...chart.labels.values,
        visible: authored?.values?.visible ?? chart.data.series.length === 1,
      },
    },
  };
}

/** The overlay panel's editorial content: the header (icon + title + subtitle) anchors to the column top, and the body (bullets, then chip) stacks directly beneath it, so the lower panel stays free for a breakout illustration. Title, subtitle and per-bullet heights come from `solvePanelLayout`'s measured fixpoint (the wrap estimate standing in until measurements land), so reserved and rendered space agree and wrapped bullets never overlap their neighbours. Reads the sidecar text directly, and its headlines carry `textKey`s so the sidecar's `textStyle.<key>*` overrides (font/colour/size) apply and the Edit-text drill-in offers them. Lays out against the FULL frame's panel region since it mounts outside the cutout's `FormatContext`. The frame's `chart` slot hosts the scene's panel-mounted chart in the same column, in the band `framePanelChartSlot` measures. */
function PanelContent({ frame }: { frame: FrameSpec }) {
  const doc = useSceneDoc();
  const format = useFormat();
  const theme = useTheme();
  const decorations = frame.decorations ?? [];
  const hosted = !!frame.chart && frame.chart.enabled !== false;
  const chart = useMemo(() => (hosted ? panelChart(doc) : null), [hosted, doc]);
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

  const col = framePanelLayout(format, frame);
  // A chart that replaces the text owns the column outright, so the editorial content stands down; the decorations are frame-placed breakouts and stay.
  const replaced = !!chart && framePanelChartReplaces(frame.chart);
  // When the frame doesn't claim the scene text, the in-world headline shows instead, so the panel omits it.
  const claimed = frame.claimsSceneText !== false && !replaced;
  const title = claimed ? (doc?.text?.title ?? "") : "";
  const subtitle = claimed ? (doc?.text?.subtitle ?? "") : "";
  const bullets = claimed ? splitBullets(doc?.text?.bullets) : [];
  const icon = replaced ? undefined : frame.icon;
  const chip = replaced ? undefined : frame.chip;
  const hasText = title.trim() || subtitle.trim() || bullets.length > 0;
  if (!hasText && !icon && !chip && decorations.length === 0 && !chart) return null;

  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const { fit, titleH, subH, bulletHeights, bulletIndent } = solution;

  const titleSize = baseTitle * fit;
  const subtitleSize = baseTitle * SUBTITLE_OF_TITLE * fit;
  const bulletSize = baseTitle * BULLET_OF_TITLE * fit;
  // The nominal icon box; FrameIcon applies the sidecar multiplier to the mark itself, so only the stacking budget below scales it here.
  const iconSize = baseTitle * ICON_SIZE * fit;
  const iconScale = headerIconScale(doc ?? undefined);
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
  if (icon) y -= iconSize * iconScale + ICON_GAP * titleSize;
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
  const chipGap = bullets.length > 0 && chip ? CHIP_GAP * bulletSize : 0;
  const bodyHeight = bulletsHeight + chipGap + (chip ? chipHeight : 0);
  const bodyGap = HEADER_BODY_GAP * titleSize;
  // What the chart band has to clear: the solved header, plus the body when one draws.
  const textHeight = col.top - headerBottom + (bodyHeight > 0 ? bodyGap + bodyHeight : 0);
  const slot = chart ? framePanelChartSlot(col, frame.chart, textHeight) : undefined;
  // A chart under the text takes the bottom of the column, so the body's floor lifts to the slot's gap.
  const textBottom = slot && !slot.replaces ? slot.textBottom : col.bottom;
  let bodyTop = headerBottom - bodyGap;
  bodyTop = Math.max(bodyTop, textBottom + bodyHeight);
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
      {icon && (
        <FrameIcon
          icon={icon}
          position={at(iconTop)}
          size={iconSize}
          from={150}
          to={700}
          anchorX={align}
          textKey={ICON_TEXT_KEY}
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
      {bullets.map((line, i) => {
        const top = bulletTops[i] ?? bodyTop;
        // Hanging indent: the marker is its own node at the column edge and the text wraps inside the remaining width, so continuation lines clear the marker. The indent IS the old prefix's advance, so an unwrapped bullet keeps its geometry. Centre/right alignment keeps the single string (a marker pinned left of centred text would read as a stray dot).
        if (bulletIndent <= 0) {
          return (
            <AnimatedHeadline
              key={line}
              text={`${BULLET_MARKER}${BULLET_GAP}${line}`}
              textKey="bullets"
              from={500 + i * 140}
              to={1000 + i * 140}
              position={at(top)}
              fontSize={bulletSize}
              face="body"
              anchorX={align}
              anchorY="top"
              textAlign={align}
              maxWidth={col.width}
            />
          );
        }
        // The line mounts before its marker so the scene-name derivation (largest mounted text, first wins a tie) reads the bullet, never the dot.
        return (
          <Fragment key={line}>
            <AnimatedHeadline
              text={line}
              textKey="bullets"
              from={500 + i * 140}
              to={1000 + i * 140}
              position={[alignX + bulletIndent, top, 0]}
              fontSize={bulletSize}
              face="body"
              anchorX={align}
              anchorY="top"
              textAlign={align}
              maxWidth={col.width - bulletIndent}
            />
            <AnimatedHeadline
              text={BULLET_MARKER}
              textKey="bullets"
              from={500 + i * 140}
              to={1000 + i * 140}
              position={at(top)}
              fontSize={bulletSize}
              face="body"
              anchorX={align}
              anchorY="top"
              textAlign={align}
            />
          </Fragment>
        );
      })}
      {chip && (
        <FrameChip
          chip={chip}
          position={[alignX, chipBottom, 0]}
          height={chipHeight}
          from={700}
          to={1300}
          anchorFrac={chipAnchor}
        />
      )}
      {chart && slot && <MountedChart chart={chart} panel={slot.rect} />}
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
