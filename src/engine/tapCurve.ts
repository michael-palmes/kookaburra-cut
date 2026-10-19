/** The tap highlight's motion curve, the one source for the video editor (Preview.tsx, tapAnimation.ts) and the scene toolkit (`TapRing`, sidecar `taps`). Hand-mirrored where TypeScript can't reach: scripts/generate-tap-dot.mjs (`tapDotFrame`) and edit.rs (`TAP_ANIMATION_DURATION_MS`); tapCurve.test.ts pins both mirrors. */

export const TAP_ANIMATION_DURATION_MS = 550;

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

/** iOS AssistiveTouch-like glow dot: quick pop-in, one soft pulse, settle, fade. */
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

/** The pulse `elapsedMs` after a tap starts, or null outside its window. */
export function tapPulseAt(elapsedMs: number): { opacity: number; scale: number } | null {
  const p = tapProgress(elapsedMs);
  return p === null ? null : tapDotFrame(p);
}
