import { ease } from "./ease";

/** A one-shot attack, hold, release envelope (camera kicks, toolkit `pulse`). Times are ms; `ease` shapes both ramps (an `engine/ease.ts` name or a function of 0..1). */
export interface EnvelopeSpec {
  attackMs?: number;
  holdMs?: number;
  releaseMs: number;
  ease?: string | ((t: number) => number);
}

export const DEFAULT_ENVELOPE_EASE = "outQuad";

/** The envelope's level at `u` ms after its start: exactly 0 before and after, `ease(u / attack)` rising, 1 through the hold, `1 - ease(p)` falling. A zero attack snaps to 1 at `u = 0`. */
export function envelopeAt(u: number, spec: EnvelopeSpec): number {
  if (!(u >= 0)) return 0;
  const attack = Math.max(0, spec.attackMs ?? 0);
  const hold = Math.max(0, spec.holdMs ?? 0);
  const release = Math.max(0, spec.releaseMs);
  if (u >= attack + hold + release) return 0;
  const curve = spec.ease ?? DEFAULT_ENVELOPE_EASE;
  const shape = typeof curve === "function" ? curve : (t: number) => ease(curve, t);
  if (u < attack) return shape(u / attack);
  if (u < attack + hold) return 1;
  return 1 - shape((u - attack - hold) / release);
}

/** Total length of the envelope in ms (where it returns to exactly 0). */
export function envelopeLengthMs(spec: EnvelopeSpec): number {
  return (
    Math.max(0, spec.attackMs ?? 0) + Math.max(0, spec.holdMs ?? 0) + Math.max(0, spec.releaseMs)
  );
}
