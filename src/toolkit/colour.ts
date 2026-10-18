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
