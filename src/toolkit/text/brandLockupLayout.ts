/** Advance in em for the overflow fit; deliberately wide so estimates err toward shrinking, never clipping. */
const FIT_ADVANCE_EM = 0.55;
/** Typical advance in em for centring; wide estimates here would lean the block left. */
const CENTRE_ADVANCE_EM = 0.46;
/** Gap between the icon's right edge and the text column, world units. */
const TEXT_GAP = 0.3;

export interface LockupLayout {
  /** Icon centre x, block-local (text column left edge is x=0). */
  iconX: number;
  /** Shift centring the whole block on the group origin. */
  centreOffset: number;
  /** Extra scale so the block fits the usable width (1 when it already fits). */
  fit: number;
  /** Estimated block width, world units (drives the shine extent). */
  width: number;
}

/** Longest line's character count; sidecar strings may carry `\n`. */
function longestLine(s: string): number {
  return s.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

/** Estimated text width in world units, a pure function of the string so layout never depends on font load timing. */
function estimateWidth(s: string, fontSize: number, advanceEm: number): number {
  return longestLine(s) * advanceEm * fontSize;
}

/** Widest text column across both lines at the given advance. */
function textWidth(
  opts: { title: string; subtitle: string; titleSize: number; subtitleSize: number },
  advanceEm: number,
): number {
  return Math.max(
    estimateWidth(opts.title, opts.titleSize, advanceEm),
    estimateWidth(opts.subtitle, opts.subtitleSize, advanceEm),
  );
}

/** Centre and fit the icon + text block from character-count estimates. */
export function lockupLayout(opts: {
  title: string;
  subtitle: string;
  iconWidth: number;
  titleSize: number;
  subtitleSize: number;
  /** Usable frame width in block-local units (frame minus safe insets, over the format scale). */
  usableWidth: number;
}): LockupLayout {
  const width = opts.iconWidth + TEXT_GAP + textWidth(opts, FIT_ADVANCE_EM);
  const left = -(TEXT_GAP + opts.iconWidth);
  return {
    iconX: left + opts.iconWidth / 2,
    centreOffset: -(left + textWidth(opts, CENTRE_ADVANCE_EM)) / 2,
    fit: opts.usableWidth > 0 ? Math.min(1, opts.usableWidth / width) : 1,
    width,
  };
}
