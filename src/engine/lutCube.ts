/** Pure `.cube` (Adobe/IRIDAS) 3D LUT parser, no three.js/fetch/clock reads, so it unit-tests in isolation (mirrors clipFrame.ts / effectParams.ts vs their three-heavy hosts). engine/effects.ts feeds the parsed table into a `Data3DTexture` for postprocessing's `LUT3DEffect`; parsing is pure, so the LUT texture two Verify runs sample is always identical. See docs/determinism.md. */

export interface CubeLut {
  /** Grid size N; the table holds N³ entries. */
  size: number;
  /** RGBA float entries (alpha 1), red coordinate fastest, the `.cube` data order and also exactly `Data3DTexture`'s x-fastest layout, so this uploads without reshuffling. */
  data: Float32Array;
}

/** Sane ceiling: 128³ RGBA floats ≈ 8 MB; real grades ship at 16-65, the spec caps at 256. */
const MAX_SIZE = 128;

/** Parse a `.cube` text into an RGBA float table. Throws (actionably) outside the supported LDR subset: `LUT_3D_SIZE` is required, 1D LUTs are rejected, and a custom `DOMAIN_MIN`/`DOMAIN_MAX` is rejected since the effect samples an implicit [0,1] domain. */
export function parseCubeLut(text: string): CubeLut {
  let size = 0;
  let data: Float32Array | null = null;
  let filled = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("TITLE")) continue;

    if (line.startsWith("LUT_1D_SIZE")) {
      throw new Error("1D .cube LUTs are not supported — export a 3D LUT (LUT_3D_SIZE).");
    }
    if (line.startsWith("LUT_3D_SIZE")) {
      const n = Number(line.split(/\s+/)[1]);
      if (!Number.isInteger(n) || n < 2 || n > MAX_SIZE) {
        throw new Error(`Invalid LUT_3D_SIZE "${line}" — expected an integer in [2, ${MAX_SIZE}].`);
      }
      size = n;
      data = new Float32Array(n * n * n * 4);
      continue;
    }
    if (line.startsWith("DOMAIN_MIN") || line.startsWith("DOMAIN_MAX")) {
      const want = line.startsWith("DOMAIN_MIN") ? [0, 0, 0] : [1, 1, 1];
      const got = line.split(/\s+/).slice(1).map(Number);
      if (got.length !== 3 || got.some((v, i) => v !== want[i])) {
        throw new Error(
          `Custom LUT domains are not supported ("${line}") — re-export the LUT over [0,1].`,
        );
      }
      continue;
    }

    // Anything else must be a data row: three floats (red coordinate advancing fastest).
    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      throw new Error(`Malformed .cube line "${line}" — expected "r g b".`);
    }
    if (!data) {
      throw new Error("Malformed .cube file — data rows before LUT_3D_SIZE.");
    }
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new Error(`Malformed .cube line "${line}" — non-numeric component.`);
    }
    if (filled >= size * size * size) {
      throw new Error(`Too many data rows in .cube file — expected ${size ** 3}.`);
    }
    const o = filled * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 1;
    filled++;
  }

  if (!data) throw new Error("Missing LUT_3D_SIZE — not a 3D .cube file.");
  if (filled !== size * size * size) {
    throw new Error(`Truncated .cube file — got ${filled} of ${size ** 3} data rows.`);
  }
  return { size, data };
}
