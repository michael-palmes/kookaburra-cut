import type { ThemeBackdrop, ThemeShadowSpec } from "../../theme/tokens";

// ── Shadow rig (export contract) ─────────────────────────────────────
// Shared by the sun (SceneStage) and shadow-casting free lights (StageLights). CHANGING ANY OF THESE REBASES EVERY STAGED PROJECT.

/** Ortho shadow-camera half-extent, covers the stage; FIXED, never auto-fit. */
export const SHADOW_FRUSTUM_EXTENT = 8;
export const SHADOW_NEAR = 0.5;
export const SHADOW_FAR = 30;
/** `softness` 0..1 -> VSM blur radius. */
export const SHADOW_RADIUS_SCALE = 8;
/** VSM gaussian tap count (three default, pinned explicitly). */
export const SHADOW_BLUR_SAMPLES = 8;

export function stageMapShadowsEnabled(
  hasBackdrop: boolean,
  shadow: ThemeShadowSpec | undefined,
): boolean {
  return Boolean(hasBackdrop && shadow && shadow.technique === "map" && shadow.enabled !== false);
}

export function stageShadowCatcherMode(
  backdropType: ThemeBackdrop["type"],
  shadow: ThemeShadowSpec | undefined,
): "none" | "floor" | "full" {
  if (!shadow) return "none";
  if (shadow.catchBackdrop !== false) return "full";
  return backdropType === "floor" ? "floor" : "none";
}
