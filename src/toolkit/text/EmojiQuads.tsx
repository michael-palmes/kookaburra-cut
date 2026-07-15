import { useEffect, useSyncExternalStore } from "react";
import {
  EMOJI_RASTER_SIZE,
  emojiRasterVersion,
  ensureEmojiRasters,
  getEmojiTexture,
  subscribeEmojiRasters,
} from "./emojiRaster";
import type { EmojiCluster } from "./emojiText";

/** World size of the full raster cell in em, pinned to the original 1.15 em @ 256 px mapping so raster-cell bumps never change on-screen emoji scale; art occupies its natural fraction of the cell (~0.9 em for a nominal glyph). */
export const EMOJI_QUAD_EM = EMOJI_RASTER_SIZE * (1.15 / 256);
/** Vertical nudge in em from the caret midpoint (emoji art carries internal padding). */
export const EMOJI_BASELINE_NUDGE_EM = 0;

/** One quad's fully resolved frame state; every field is in the parent Text's local space (offsets already × fontSize). */
export interface EmojiQuadState {
  key: string;
  /** Caret-centre position in layout space. */
  x: number;
  y: number;
  alpha: number;
  scale: number;
  dx: number;
  dy: number;
  dz: number;
  /** Twist: rotation about the Y axis at `rotYPivotX` (the stagger unit's centre). */
  rotYRad: number;
  rotYPivotX: number;
  /** Scatter: roll about the quad's own centre. */
  rotZRad: number;
  /** Mask-reveal coverage multiplier, 0..1. */
  coverage: number;
}

/** The caret rectangle for one substituted placeholder: quad centre + x extent. */
export function caretQuad(
  carets: Float32Array,
  codeUnitIndex: number,
): { x: number; y: number; x0: number; x1: number } | null {
  const i = codeUnitIndex * 4;
  if (i + 3 >= carets.length) return null;
  const x0 = Math.min(carets[i], carets[i + 1]);
  const x1 = Math.max(carets[i], carets[i + 1]);
  return { x: (x0 + x1) / 2, y: (carets[i + 2] + carets[i + 3]) / 2, x0, x1 };
}

/** Fraction of a quad's x-extent covered by a sweep window (the coarse mask-reveal gate). */
export function sweepCoverage(
  x: number,
  halfWidth: number,
  windowLeft: number,
  windowRight: number,
): number {
  const lo = Math.max(x - halfWidth, windowLeft);
  const hi = Math.min(x + halfWidth, windowRight);
  return Math.max(0, Math.min(1, (hi - lo) / (2 * halfWidth)));
}

/**
 * Colour emoji as textured planes in the same canvas, one per cluster occurrence,
 * positioned from troika caret positions and animated by CPU-mirrored per-unit
 * transforms. Renders nothing when there are no clusters or no textures yet, so
 * emoji-free text is structurally unchanged.
 */
export function EmojiQuads(props: {
  clusters: readonly EmojiCluster[];
  states: readonly EmojiQuadState[];
  fontSize: number;
}) {
  const { clusters, states, fontSize } = props;
  useSyncExternalStore(subscribeEmojiRasters, emojiRasterVersion);
  // Live-typing self-heal: a brand-new emoji rasterises async and the quad lands next commit; export always settles rasters in the preamble and the per-frame barrier. Cache hits make the every-render call a no-op.
  const missing = clusters.filter((c) => !getEmojiTexture(c.key));
  useEffect(() => {
    if (missing.length > 0) void ensureEmojiRasters(missing);
  });
  if (states.length === 0) return null;
  const size = EMOJI_QUAD_EM * fontSize;
  return (
    <>
      {states.map((s, i) => {
        const tex = getEmojiTexture(s.key);
        const opacity = s.alpha * s.coverage;
        if (!tex || opacity <= 0) return null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: occurrences are position-stable per text
          <group key={`${s.key}:${i}`} position={[s.dx, s.dy, s.dz]}>
            <group position={[s.rotYPivotX, 0, 0]} rotation={[0, s.rotYRad, 0]}>
              <group
                position={[s.x - s.rotYPivotX, s.y + EMOJI_BASELINE_NUDGE_EM * fontSize, 0]}
                rotation={[0, 0, s.rotZRad]}
                scale={s.scale}
              >
                <mesh>
                  <planeGeometry args={[size, size]} />
                  <meshBasicMaterial
                    map={tex}
                    transparent
                    toneMapped={false}
                    opacity={opacity}
                    depthWrite={false}
                  />
                </mesh>
              </group>
            </group>
          </group>
        );
      })}
    </>
  );
}
