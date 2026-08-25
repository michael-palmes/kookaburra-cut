import type { StaggerUnits, TextUnitSample } from "./presets";
import { unitIndexForKey } from "./presets";

/** Accent block padding beyond the unit's ink extents, em. */
export const HIGHLIGHT_PAD_X_EM = 0.14;
export const HIGHLIGHT_PAD_Y_EM = 0.1;
/** Companion accent layers (highlight blocks, underline rule) sit just behind the glyph plane, em. */
export const ACCENT_LAYER_Z_EM = -0.012;

/** Per-unit vertical ink extents ([minY, maxY] pairs, layout space) from troika carets, keyed to the same unit walk as the shader (whitespace joins no unit; empty units collapse to zero). */
export function computeUnitYExtents(
  units: StaggerUnits,
  text: string,
  caretPositions: Float32Array,
): Float32Array {
  const boxes = new Float32Array(units.count * 2);
  for (let i = 0; i < units.count; i++) {
    boxes[i * 2] = Number.POSITIVE_INFINITY;
    boxes[i * 2 + 1] = Number.NEGATIVE_INFINITY;
  }
  const charCount = Math.min(text.length, Math.floor(caretPositions.length / 4));
  for (let i = 0; i < charCount; i++) {
    if (/\s/.test(text[i])) continue;
    const yLo = Math.min(caretPositions[i * 4 + 2], caretPositions[i * 4 + 3]);
    const yHi = Math.max(caretPositions[i * 4 + 2], caretPositions[i * 4 + 3]);
    const key =
      units.axis === "-y"
        ? -(yLo + yHi) / 2
        : (caretPositions[i * 4] + caretPositions[i * 4 + 1]) / 2;
    const unit = unitIndexForKey(units, key);
    boxes[unit * 2] = Math.min(boxes[unit * 2], yLo);
    boxes[unit * 2 + 1] = Math.max(boxes[unit * 2 + 1], yHi);
  }
  for (let i = 0; i < units.count; i++) {
    if (boxes[i * 2] > boxes[i * 2 + 1]) {
      boxes[i * 2] = 0;
      boxes[i * 2 + 1] = 0;
    }
  }
  return boxes;
}

export interface HighlightQuad {
  unit: number;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

/** Accent block windows: each unit's `highlight` [l, r] maps over its padded extent; centres ride the unit's dx/dy so a block tracks a moving word. Pure maths over the frame's samples. */
export function highlightQuads(
  units: StaggerUnits,
  unitBoxes: Float32Array,
  samples: readonly TextUnitSample[],
  fontSize: number,
): HighlightQuad[] {
  const quads: HighlightQuad[] = [];
  const padX = HIGHLIGHT_PAD_X_EM * fontSize;
  const padY = HIGHLIGHT_PAD_Y_EM * fontSize;
  const n = Math.min(units.count, samples.length, unitBoxes.length / 2);
  for (let i = 0; i < n; i++) {
    const sample = samples[i];
    const [l, r] = sample.highlight;
    if (r <= l || sample.alpha <= 0) continue;
    const left = units.startX[i] - padX;
    const w = units.endX[i] + padX - left;
    if (w <= 0) continue;
    const x0 = left + l * w;
    const x1 = left + r * w;
    const y0 = unitBoxes[i * 2] - padY;
    const y1 = unitBoxes[i * 2 + 1] + padY;
    if (x1 <= x0 || y1 <= y0) continue;
    quads.push({
      unit: i,
      x: (x0 + x1) / 2 + sample.dxEm * fontSize,
      y: (y0 + y1) / 2 + sample.dyEm * fontSize,
      w: x1 - x0,
      h: y1 - y0,
      opacity: sample.alpha,
    });
  }
  return quads;
}

/** Deterministic CPU accent blocks keyed off StaggerUnits extents (the EmojiQuads mount pattern: same parent transforms, unit planes scaled per frame so geometry never re-creates). */
export function HighlightQuads(props: {
  units: StaggerUnits;
  unitBoxes: Float32Array;
  samples: readonly TextUnitSample[];
  fontSize: number;
  color: string;
}) {
  const quads = highlightQuads(props.units, props.unitBoxes, props.samples, props.fontSize);
  if (quads.length === 0) return null;
  const z = ACCENT_LAYER_Z_EM * props.fontSize;
  return (
    <>
      {quads.map((quad) => (
        <mesh key={quad.unit} position={[quad.x, quad.y, z]} scale={[quad.w, quad.h, 1]}>
          <planeGeometry />
          <meshBasicMaterial
            color={props.color}
            transparent
            opacity={quad.opacity}
            depthWrite={false}
          />
        </mesh>
      ))}
    </>
  );
}
