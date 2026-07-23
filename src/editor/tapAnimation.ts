/** The tap-highlight animation spec, shared so what you see while editing matches the render: the DOM preview (Preview.tsx) reads these directly, scripts/generate-tap-dot.mjs mirrors tapDotFrame() when baking the overlay frames, and edit.rs mirrors TAP_DOT_SIZE_FRACTION. Keep all three in sync by hand. Style shapes and colours live in tapStyles.generated.ts (the generator is their single source of truth). */

import type { TapColor, TapStyle } from "./tapStyles.generated";

export const TAP_ANIMATION_DURATION_MS = 550;

/** Dot diameter as a fraction of min(width, height); mirrored in edit.rs. */
export const TAP_DOT_SIZE_FRACTION = 0.07;

/** Baked overlay frames at 60fps (600ms, comfortably past the duration). */
export const TAP_DOT_FRAME_COUNT = 36;

/** Edit-marker visibility margin around a tap's window in "near playhead" scope. */
export const TAP_MARKER_NEAR_MS = 200;

/** The preview gradient for a style in a colour, matching the baked white frames plus the render-time tint. */
export function tapGradient(style: TapStyle, color: TapColor): string {
  const [r, g, b] = color.rgb;
  const parts = style.alphaStops.map(([t, a]) => `rgba(${r}, ${g}, ${b}, ${a}) ${t * 100}%`);
  return `radial-gradient(circle closest-side, ${parts.join(", ")})`;
}

/** Progress 0..1 through the animation, or null outside it. */
export function tapProgress(elapsedMs: number): number | null {
  if (elapsedMs < 0 || elapsedMs > TAP_ANIMATION_DURATION_MS) return null;
  return elapsedMs / TAP_ANIMATION_DURATION_MS;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** iOS AssistiveTouch-like glow dot: quick pop-in, one soft pulse, settle, fade. Mirrored in scripts/generate-tap-dot.mjs. */
export function tapDotFrame(p: number): { opacity: number; scale: number } {
  if (p < 0.15) {
    const t = easeOutCubic(p / 0.15);
    return { opacity: lerp(0, 0.9, t), scale: lerp(0.4, 1, t) };
  }
  if (p < 0.4) {
    const t = (p - 0.15) / 0.25;
    return { opacity: lerp(0.9, 0.75, t), scale: lerp(1, 1.12, t) };
  }
  if (p < 0.65) {
    const t = (p - 0.4) / 0.25;
    return { opacity: lerp(0.75, 0.6, t), scale: lerp(1.12, 1, t) };
  }
  const t = (p - 0.65) / 0.35;
  return { opacity: lerp(0.6, 0, t), scale: lerp(1, 0.92, t) };
}
