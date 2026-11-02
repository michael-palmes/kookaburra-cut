import { liftColour } from "../colour";

/** The depth stack. Every field is optional. */
export interface HeadlineDepth {
  /** How far the stack reaches behind the face, em (default 0.12). */
  em?: number;
  /** The direction it recedes, degrees counter-clockwise from +x (default -45, down and right). */
  angleDeg?: number;
  /** How many layers, 1 to 32 (default 12); more is smoother and costs a typeset and a draw each. */
  layers?: number;
  /** The deepest layer's colour, a theme token or hex (default the face colour, mostly darkened). */
  dark?: "text" | "muted" | "accent" | (string & {});
  /** The nearest layer's colour, a theme token or hex (default the face colour, a little darkened). */
  light?: "text" | "muted" | "accent" | (string & {});
}

const DEPTH_EM = 0.12;
const DEPTH_ANGLE_DEG = -45;
const DEPTH_LAYERS = 12;
const DEPTH_MAX_LAYERS = 32;
const DEPTH_DARK_LIFT = 0.82;
const DEPTH_LIGHT_LIFT = 0.38;
/** The stack really recedes, so a moving camera sees it: its z reach as a share of its screen reach. */
const DEPTH_Z_SHARE = 0.25;

export interface DepthLayer {
  /** Its place in the stack, deepest first; a stable key however small the reach. */
  index: number;
  colour: string;
  /** World offset from the face. */
  offset: [number, number, number];
}

/** The under-layers, deepest first, so they draw back to front: shades run dark to light as they near the face, evenly spaced to the full reach. */
export function depthLayers(
  spec: HeadlineDepth,
  faceHex: string,
  fontSize: number,
  resolveColour: (colour: string) => string,
): DepthLayer[] {
  const dark = spec.dark
    ? resolveColour(spec.dark)
    : liftColour(faceHex, "#000000", DEPTH_DARK_LIFT);
  const light = spec.light
    ? resolveColour(spec.light)
    : liftColour(faceHex, "#000000", DEPTH_LIGHT_LIFT);
  const count = Math.min(DEPTH_MAX_LAYERS, Math.max(1, Math.round(spec.layers ?? DEPTH_LAYERS)));
  const reach = (spec.em ?? DEPTH_EM) * fontSize;
  const rad = ((spec.angleDeg ?? DEPTH_ANGLE_DEG) * Math.PI) / 180;
  const layers: DepthLayer[] = [];
  for (let i = 0; i < count; i++) {
    const out = (count - i) / count;
    layers.push({
      index: i,
      colour: liftColour(dark, light, count === 1 ? 1 : i / (count - 1)),
      offset: [
        Math.cos(rad) * reach * out,
        Math.sin(rad) * reach * out,
        -reach * DEPTH_Z_SHARE * out,
      ],
    });
  }
  return layers;
}
