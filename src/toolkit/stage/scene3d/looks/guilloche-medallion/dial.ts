import { medallionTurn } from "../../kit/medallion";

/** Dial layout and clock. Radii are dial units: the Dial size param scales them so the outer rings sit at `outerRadius` world units. */
export const GUILLOCHE = {
  floorY: -2,
  baseRadius: 37,
  discRadius: 40,
  turnPeriod: 300,
  weavePeriodA: 120,
  weavePeriodB: 150,
  sheenPeriod: 60,
  loop: 600,
  maxStrands: 12,
} as const;

/** Shader loop bounds per band: no fragment evaluates more than 12 strands. */
export const GUILLOCHE_LOOP = { lace: 12, braid: 6, rosette: 12, border: 3 } as const;

/** Strands per band from the Strands per band slider: lace, braid (per family), rosette and border (per family), at the sketch's 8 / 5 / 7 / 2 by default. */
export interface GuillocheCounts {
  lace: number;
  braid: number;
  rosette: number;
  border: number;
}

export function guillocheCounts(strands: number): GuillocheCounts {
  const s = Math.min(GUILLOCHE.maxStrands, Math.max(4, Math.round(strands)));
  return {
    lace: s,
    braid: Math.min(GUILLOCHE_LOOP.braid, Math.max(2, Math.round((s * 5) / 8))),
    rosette: Math.max(3, Math.round((s * 7) / 8)),
    border: Math.min(GUILLOCHE_LOOP.border, Math.max(1, Math.round(s / 4))),
  };
}

/** Clock angles (radians): the dial turn, the two re-weave phases and the sheen sweep. The ceiling negates them in the shader. */
export interface GuillochePhases {
  turn: number;
  weaveA: number;
  weaveB: number;
  sheen: number;
}

export function guillochePhases(t: number, weave: number): GuillochePhases {
  return {
    turn: medallionTurn(t, GUILLOCHE.turnPeriod),
    weaveA: medallionTurn(t * weave, GUILLOCHE.weavePeriodA),
    weaveB: medallionTurn(t * weave, GUILLOCHE.weavePeriodB),
    sheen: medallionTurn(t, GUILLOCHE.sheenPeriod),
  };
}
