import { Color, SRGBColorSpace } from "three";

const _c = new Color();
const _from = { r: 0, g: 0, b: 0 };
const _to = { r: 0, g: 0, b: 0 };

/** Blends `from` toward `to` by `amount` in DISPLAY (sRGB) space, returning a hex string. Perceptually even and symmetric between light and dark themes (the overlay panel's surface-lift maths, shared so scenes can derive secondary surfaces from theme tokens). Pure and deterministic. */
export function liftColour(from: string, to: string, amount: number): string {
  _c.set(from).getRGB(_from, SRGBColorSpace);
  _c.set(to).getRGB(_to, SRGBColorSpace);
  _c.setRGB(
    _from.r + amount * (_to.r - _from.r),
    _from.g + amount * (_to.g - _from.g),
    _from.b + amount * (_to.b - _from.b),
    SRGBColorSpace,
  );
  return `#${_c.getHexString()}`;
}

/** `fg` at opacity `a` over a room colour, as the opaque hex a CSS overlay would show (the `liftColour` display-domain blend), so text and panels over a room stay exact. */
export function cssOpacity(fg: string, room: string, a: number): string {
  return liftColour(room, fg, a);
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Linear value of an sRGB 255 channel, with float slack. */
const FULL = 0.999;

/** `hex` brightened in linear light to luminance `glow` by raising only its full (255) channels: past a bloom threshold above 1 it glows, and once clamped (tone mapping off, or `linear`) it lands exactly on `hex`. A colour with no full channel scales whole, which is not exact; a `glow` at or under its own luminance returns it unchanged. */
export function glowColour(hex: string, glow: number): Color {
  const c = new Color(hex);
  const ch = [c.r, c.g, c.b];
  const lum = ch.reduce((sum, v, i) => sum + LUMA[i] * v, 0);
  if (!(glow > lum)) return c;
  let fullWeight = 0;
  let rest = 0;
  ch.forEach((v, i) => {
    if (v >= FULL) fullWeight += LUMA[i];
    else rest += LUMA[i] * v;
  });
  if (fullWeight > 0) {
    const v = (glow - rest) / fullWeight;
    c.setRGB(...(ch.map((x) => (x >= FULL ? v : x)) as [number, number, number]));
  } else if (lum > 0) {
    c.multiplyScalar(glow / lum);
  }
  return c;
}
