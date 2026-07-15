import { useContext } from "react";
import { SceneThemeContext } from "../engine/sceneContext";
import { useEditorStore } from "../store/editorStore";
import type { Theme } from "./tokens";

export { defaultTheme } from "./registry";
export type { Theme } from "./tokens";

/** The active theme: inside `<SceneHost>` it's the scene's resolved theme (project theme unless the sidecar overrides `themeId`); elsewhere it falls back to the editor store's theme, since r3f's reconciler doesn't bridge context outside the `<Canvas>` boundary. */
export function useTheme(): Theme {
  const sceneTheme = useContext(SceneThemeContext);
  const storeTheme = useEditorStore((s) => s.theme);
  return sceneTheme ?? storeTheme;
}
