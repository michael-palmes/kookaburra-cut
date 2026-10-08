const EPSILON = 1e-9;

const same = (a: number, b: number) => Math.abs(a - b) < EPSILON;

/** Whether a background still carries every value its stored preset stamped; a colour, motion or backing edit since then reads as Custom (edits keep `preset`, so the id alone can't tell). */
export function presetStillApplied(
  spec: {
    colors?: readonly string[];
    speed?: number;
    scale?: number;
    params?: Readonly<Record<string, number>>;
    backing?: { type: string; color?: string };
  },
  preset: {
    colors: readonly string[];
    speed?: number;
    scale?: number;
    params?: Readonly<Record<string, number>>;
    backing?: string;
  },
  paramDefaults: Readonly<Record<string, { default: number }>>,
): boolean {
  const colors = spec.colors ?? [];
  if (colors.length !== preset.colors.length) return false;
  if (colors.some((hex, i) => hex.toLowerCase() !== preset.colors[i]?.toLowerCase())) return false;
  if (!same(spec.speed ?? 1, preset.speed ?? 1)) return false;
  if (!same(spec.scale ?? 1, preset.scale ?? 1)) return false;
  const keys = new Set([
    ...Object.keys(paramDefaults),
    ...Object.keys(spec.params ?? {}),
    ...Object.keys(preset.params ?? {}),
  ]);
  for (const key of keys) {
    const fallback = paramDefaults[key]?.default ?? 0;
    if (!same(spec.params?.[key] ?? fallback, preset.params?.[key] ?? fallback)) return false;
  }
  if (preset.backing === undefined) return true;
  return (
    spec.backing?.type === "color" &&
    spec.backing.color?.toLowerCase() === preset.backing.toLowerCase()
  );
}
