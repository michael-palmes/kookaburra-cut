import { type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import type { Group } from "three";
import { useEditorStore } from "../store/editorStore";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import { resolveCutoutRender } from "./frameFormat";
import {
  AnimatedFixtureLightIdsContext,
  FormatContext,
  SceneContext,
  SceneDocContext,
  SceneTextClaimedContext,
  SceneThemeContext,
} from "./sceneContext";
import type { SceneDoc } from "./sceneDocSchema";
import { registerSceneHost, unregisterSceneHost } from "./sceneHostRegistry";

const NO_ANIMATED_FIXTURE_LIGHT_IDS: ReadonlySet<string> = new Set();

interface SceneHostProps {
  index: number;
  id: string;
  startMs: number;
  durationMs: number;
  /** The scene's sidecar document, if it has one. */
  doc?: SceneDoc;
  /** The scene's resolved theme (`LoadedProject.sceneThemes[index]`). */
  theme?: Theme;
  /** The scene's resolved overlay (`LoadedProject.sceneFrames[index]`); narrows `useFormat()` to the cutout so the scene lays out inside it. */
  frame?: FrameSpec;
  /** A comparison's side-B host: same index and timing as the base host, its own doc/theme; the compositor gates the pair by side. */
  side?: "b";
  /** Zero-base fixtures whose active side-specific track can animate paired lights above zero. */
  animatedFixtureLightIds?: ReadonlySet<string>;
  children: ReactNode;
}

/** Wraps one scene in a `<group>`, provides its `SceneContext` (so `useTimeline()` derives scene-local time), and registers the group with the host registry so the compositor can gate visibility per frame; all scenes mount at once and the compositor, not this prop, owns which scene is drawn. */
export function SceneHost({
  index,
  id,
  startMs,
  durationMs,
  doc,
  theme,
  frame,
  side,
  animatedFixtureLightIds,
  children,
}: SceneHostProps) {
  const key = useId();
  const groupRef = useRef<Group>(null);

  // The cutout as its own frame: null (no override, store fallback) unless the scene has an overlay. Recomputed only when the export format or this scene's frame changes, so a framed scene lays out stably, never per render.
  const format = useEditorStore((s) => s.format);
  const cutoutFormat = useMemo(
    () =>
      frame && frame.cutout.shape !== "none" ? resolveCutoutRender(format, frame).format : null,
    [frame, format],
  );
  // The overlay claims the scene's headline unless it opted out; `TitleBlock` reads this and renders null so the title lives only in the panel.
  const textClaimed = !!frame && frame.claimsSceneText !== false;

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    registerSceneHost(key, { index, id, startMs, durationMs, group, side });
    return () => unregisterSceneHost(key);
  }, [key, index, id, startMs, durationMs, side]);

  return (
    <SceneContext.Provider value={{ index, startMs, durationMs, side }}>
      <SceneDocContext.Provider value={doc ?? null}>
        <AnimatedFixtureLightIdsContext.Provider
          value={animatedFixtureLightIds ?? NO_ANIMATED_FIXTURE_LIGHT_IDS}
        >
          <SceneThemeContext.Provider value={theme ?? null}>
            <FormatContext.Provider value={cutoutFormat}>
              <SceneTextClaimedContext.Provider value={textClaimed}>
                <group ref={groupRef}>{children}</group>
              </SceneTextClaimedContext.Provider>
            </FormatContext.Provider>
          </SceneThemeContext.Provider>
        </AnimatedFixtureLightIdsContext.Provider>
      </SceneDocContext.Provider>
    </SceneContext.Provider>
  );
}
