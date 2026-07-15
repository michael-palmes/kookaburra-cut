import { type ReactNode, useEffect, useId, useRef } from "react";
import type { Group } from "three";
import type { Theme } from "../theme/tokens";
import { SceneContext, SceneDocContext, SceneThemeContext } from "./sceneContext";
import type { SceneDoc } from "./sceneDocSchema";
import { registerSceneHost, unregisterSceneHost } from "./sceneHostRegistry";

interface SceneHostProps {
  index: number;
  id: string;
  startMs: number;
  durationMs: number;
  /** The scene's sidecar document, if it has one. */
  doc?: SceneDoc;
  /** The scene's resolved theme (`LoadedProject.sceneThemes[index]`). */
  theme?: Theme;
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
  children,
}: SceneHostProps) {
  const key = useId();
  const groupRef = useRef<Group>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    registerSceneHost(key, { index, id, startMs, durationMs, group });
    return () => unregisterSceneHost(key);
  }, [key, index, id, startMs, durationMs]);

  return (
    <SceneContext.Provider value={{ index, startMs, durationMs }}>
      <SceneDocContext.Provider value={doc ?? null}>
        <SceneThemeContext.Provider value={theme ?? null}>
          <group ref={groupRef}>{children}</group>
        </SceneThemeContext.Provider>
      </SceneDocContext.Provider>
    </SceneContext.Provider>
  );
}
