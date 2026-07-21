import { useEffect, useId, useRef } from "react";
import type { Group } from "three";
import { useTheme } from "../theme";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { FrameChip } from "./FrameChip";
import { FrameIcon } from "./FrameIcon";
import { useFormat } from "./format";
import { framePanelLayout } from "./framePanelLayout";
import { registerFramePanel, unregisterFramePanel } from "./framePanelRegistry";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** Title size as a fraction of the column's width, clamped by its height (the title-slide size, before the fit-to-column scale). */
const TITLE_WIDTH_FRACTION = 0.15;
const TITLE_HEIGHT_FRACTION = 0.16;
/** Troika's default line height, so a wrapped block's budget is `lines x this x size`. */
const LINE_HEIGHT = 1.2;
/** Line budgets so a wrapped title/subtitle never collides with what follows (troika wraps async, so height is budgeted, not measured). */
const TITLE_LINE_BUDGET = 2;
const SUBTITLE_LINE_BUDGET = 2;
/** Icon edge as a multiple of the title height, and its gap above the title in title-heights. */
const ICON_SIZE = 1.25;
const ICON_GAP = 0.4;
/** Gap below the title before the subtitle, in title-heights. */
const TITLE_GAP = 0.35;
/** Gap below the subtitle before the first bullet, in subtitle-heights. */
const SUBTITLE_GAP = 0.5;
/** Bullet size as a multiple of the subtitle, and the extra gap between bullet lines. */
const BULLET_SIZE = 0.95;
const BULLET_LINE_GAP = 0.3;
/** Chip pill height and its gap above, in subtitle-heights. */
const CHIP_HEIGHT = 1.6;
const CHIP_GAP = 0.5;

function splitBullets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The overlay panel's editorial content: icon, title, subtitle and bullets flow from the column top; the chip anchors to the column bottom. Every block's height is budgeted (title/subtitle at a 2-line worst case), and the whole stack scales to fit the column, so bullets never cross the chip whatever the content. Reads the sidecar text DIRECTLY (like `TextFallback`) so it never registers as a text-key consumer, and lays out against the FULL frame's panel region since it mounts outside the cutout's `FormatContext`. */
function PanelContent({ frame }: { frame: FrameSpec }) {
  const doc = useSceneDoc();
  const theme = useTheme();
  const format = useFormat();
  const title = doc?.text?.title ?? "";
  const subtitle = doc?.text?.subtitle ?? "";
  const bullets = splitBullets(doc?.text?.bullets);
  const hasText = title.trim() || subtitle.trim() || bullets.length > 0;
  if (!hasText && !frame.icon && !frame.chip) return null;

  const col = framePanelLayout(format, frame);
  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const baseSub = baseTitle / theme.typography.scale ** 2;
  const baseBullet = baseSub * BULLET_SIZE;
  const baseIcon = baseTitle * ICON_SIZE;

  // One fit scale from worst-case block budgets, so bullets never cross the bottom chip.
  const iconBudget = frame.icon ? baseIcon + ICON_GAP * baseTitle : 0;
  const titleBudget = title.trim()
    ? TITLE_LINE_BUDGET * LINE_HEIGHT * baseTitle + TITLE_GAP * baseTitle
    : 0;
  const subBudget = subtitle.trim()
    ? SUBTITLE_LINE_BUDGET * LINE_HEIGHT * baseSub + SUBTITLE_GAP * baseSub
    : 0;
  const bulletsBudget = bullets.length * (LINE_HEIGHT + BULLET_LINE_GAP) * baseBullet;
  const chipBudget = frame.chip ? (CHIP_HEIGHT + CHIP_GAP) * baseSub : 0;
  const stack = iconBudget + titleBudget + subBudget + bulletsBudget + chipBudget;
  const fit = stack > col.height ? col.height / stack : 1;

  const titleSize = baseTitle * fit;
  const subtitleSize = baseSub * fit;
  const bulletSize = baseBullet * fit;
  const iconSize = baseIcon * fit;
  const at = (y: number): V3 => [col.left, y, 0];

  let y = col.top;
  const iconTop = y;
  if (frame.icon) y -= iconSize + ICON_GAP * titleSize;
  const titleTop = y;
  if (title.trim()) y -= TITLE_LINE_BUDGET * LINE_HEIGHT * titleSize + TITLE_GAP * titleSize;
  const subtitleTop = y;
  if (subtitle.trim())
    y -= SUBTITLE_LINE_BUDGET * LINE_HEIGHT * subtitleSize + SUBTITLE_GAP * subtitleSize;
  const bulletsTop = y;

  return (
    <>
      {frame.icon && (
        <FrameIcon icon={frame.icon} position={at(iconTop)} size={iconSize} from={150} to={700} />
      )}
      {title.trim() && (
        <AnimatedHeadline
          text={title}
          from={200}
          to={900}
          position={at(titleTop)}
          fontSize={titleSize}
          anchorX="left"
          anchorY="top"
          textAlign="left"
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
          anchorX="left"
          anchorY="top"
          textAlign="left"
          maxWidth={col.width}
        />
      )}
      {bullets.map((line, i) => (
        <AnimatedHeadline
          key={line}
          text={`•  ${line}`}
          from={500 + i * 140}
          to={1000 + i * 140}
          position={at(bulletsTop - i * (LINE_HEIGHT + BULLET_LINE_GAP) * bulletSize)}
          fontSize={bulletSize}
          face="body"
          anchorX="left"
          anchorY="top"
          textAlign="left"
          maxWidth={col.width}
        />
      ))}
      {frame.chip && (
        <FrameChip
          chip={frame.chip}
          position={[col.left, col.bottom, 0]}
          height={subtitleSize * CHIP_HEIGHT}
          from={700}
          to={1300}
        />
      )}
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
