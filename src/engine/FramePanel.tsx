import { useEffect, useId, useRef } from "react";
import type { Group } from "three";
import { useTheme } from "../theme";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { AnimatedHeadline } from "../toolkit/text/AnimatedHeadline";
import type { V3 } from "../toolkit/types";
import { useFormat } from "./format";
import { framePanelLayout } from "./framePanelLayout";
import { registerFramePanel, unregisterFramePanel } from "./framePanelRegistry";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import { useSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** Title size as a fraction of the text column's width, clamped by its height. */
const TITLE_WIDTH_FRACTION = 0.15;
const TITLE_HEIGHT_FRACTION = 0.16;
/** Troika's default line height, so a wrapped title's budget is `lines x this x size`. */
const LINE_HEIGHT = 1.2;
/** Vertical budget for the title, in lines, so the subtitle clears a wrapped title. */
const TITLE_LINE_BUDGET = 2;
/** Gap below the title budget before the subtitle, in title-heights. */
const SUBTITLE_GAP = 0.4;

/** The overlay panel's editorial column (phase 3a: title + subtitle). Reads the sidecar text DIRECTLY (like `TextFallback`) so it never registers as a text-key consumer, and lays out against the FULL frame's panel region since it mounts outside the cutout's `FormatContext`. */
function PanelTextColumn({ frame }: { frame: FrameSpec }) {
  const doc = useSceneDoc();
  const theme = useTheme();
  const format = useFormat();
  const title = doc?.text?.title ?? "";
  const subtitle = doc?.text?.subtitle ?? "";
  if (!title.trim() && !subtitle.trim()) return null;

  const col = framePanelLayout(format, frame);
  const titleSize = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const subtitleSize = titleSize / theme.typography.scale ** 2;
  // Both blocks anchor by their TOP edge, so a wrapped title never collides with the subtitle: the subtitle clears a fixed line budget beneath the title's top.
  const titleY = col.top;
  const subtitleY =
    col.top - TITLE_LINE_BUDGET * LINE_HEIGHT * titleSize - SUBTITLE_GAP * titleSize;
  const at = (y: number): V3 => [col.left, y, 0];

  return (
    <>
      {title.trim() && (
        <AnimatedHeadline
          text={title}
          from={200}
          to={900}
          position={at(titleY)}
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
          position={at(subtitleY)}
          fontSize={subtitleSize}
          face="body"
          color="muted"
          anchorX="left"
          anchorY="top"
          textAlign="left"
          maxWidth={col.width}
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
            <PanelTextColumn frame={frame} />
          </group>
        </SceneThemeContext.Provider>
      </SceneDocContext.Provider>
    </SceneContext.Provider>
  );
}
