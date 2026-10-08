/** Present's hold point, re-exported from its engine home (engine/presentHoldPoint.ts) so the stills exporter and Present share one derivation. */

export {
  DEFAULT_OUT_RUNWAY_MS,
  type DerivedHold,
  derivePresentHold,
  FALLBACK_HOLD_MS,
  HOLD_MARGIN_MS,
  MIN_HOLD_GAP_MS,
} from "../engine/presentHoldPoint";
