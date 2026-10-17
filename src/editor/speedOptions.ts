export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 6];

export interface SpeedChoice {
  /** The exact speed, as the select's option value. */
  value: string;
  label: string;
}

const label = (speed: number) => `${Number(speed.toFixed(3))}×`;

/** The speed menu, plus the clip's own speed in order when it is off the menu (a fit or kb edit), so the select never shows blank. */
export function speedChoices(current: number | undefined): SpeedChoice[] {
  const speeds = [...SPEED_OPTIONS];
  if (current !== undefined && Number.isFinite(current) && !speeds.includes(current)) {
    speeds.push(current);
    speeds.sort((a, b) => a - b);
  }
  return speeds.map((s) => ({ value: String(s), label: label(s) }));
}
