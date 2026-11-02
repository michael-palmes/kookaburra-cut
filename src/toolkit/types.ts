import type { ComponentType } from "react";
import type { Theme } from "../theme/tokens";

/** A 3D vector, used for positions / rotations / scales. */
export type V3 = [number, number, number];

/** Deterministic easing names, the shared `engine/ease` vocabulary (anime.js-style names, closed-form implementations); superset of the old v0 union, so existing scenes compile. */
export type { EaseName } from "../engine/ease";

/** Time exposed to a scene, all derived purely from the global clock. */
export interface SceneTime {
  /** Milliseconds since this scene's start. */
  localMs: number;
  /** Milliseconds since the project start. */
  globalMs: number;
  /** Project progress in [0, 1]. */
  progress: number;
}

/** Output format + the world-space frame & safe-area insets a scene lays out against. */
/** How a frame reads for layout, from `FormatInfo.aspect`: "wide" at 1.2 and up (16:9, 3:2, 5:4), "tall" at 0.85 and below (9:16, 2:3, 4:5, phone), "square" between (1:1). */
export type FormatShape = "wide" | "square" | "tall";

export interface FormatInfo {
  /** Output pixel width. */
  width: number;
  /** Output pixel height. */
  height: number;
  /** width / height. */
  aspect: number;
  /** "wide", "square" or "tall", from `aspect`; branch layouts on this so 1:1 gets its own answer. */
  shape: FormatShape;
  /** Visible world rectangle at the content plane; lay out against `frame.width/height`. */
  frame: { width: number; height: number };
  /** Safe-area insets in WORLD units from each edge (position content inside these). */
  safe: { top: number; right: number; bottom: number; left: number };
}

/** Everything a scene can read. Available via hooks (`useTimeline`/`useFormat`/`useTheme`). */
export interface SceneProps {
  time: SceneTime;
  format: FormatInfo;
  theme: Theme;
}

/** A registered scene: a default-exported `defineScene(...)` result. */
export interface SceneModule {
  id: string;
  durationMs: number;
  Scene: ComponentType;
  /** Set by `loadProject`: the key the compiling realm holds this module under (`engine/sceneModules`). */
  key?: string;
}
