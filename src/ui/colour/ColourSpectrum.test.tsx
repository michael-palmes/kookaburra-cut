import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ColourSpectrum, hueFromPoint, saturationValueFromPoint } from "./ColourSpectrum";

describe("saturationValueFromPoint", () => {
  const rect = { left: 10, top: 20, width: 100, height: 100 };

  it("maps the square's corners and centre", () => {
    expect(saturationValueFromPoint(rect, 60, 70)).toEqual({ s: 0.5, v: 0.5 });
    expect(saturationValueFromPoint(rect, 10, 20)).toEqual({ s: 0, v: 1 });
    expect(saturationValueFromPoint(rect, 110, 120)).toEqual({ s: 1, v: 0 });
  });

  it("clamps points outside the square, as a captured drag produces", () => {
    expect(saturationValueFromPoint(rect, -500, 900)).toEqual({ s: 0, v: 0 });
    expect(saturationValueFromPoint(rect, 900, -500)).toEqual({ s: 1, v: 1 });
  });
});

describe("hueFromPoint", () => {
  const rect = { left: 0, width: 360 };

  it("maps the rail to degrees", () => {
    expect(hueFromPoint(rect, 0)).toBe(0);
    expect(hueFromPoint(rect, 180)).toBe(180);
    expect(hueFromPoint(rect, 359)).toBe(359);
  });

  it("clamps below zero and never reaches a full wrap", () => {
    expect(hueFromPoint(rect, -40)).toBe(0);
    expect(hueFromPoint(rect, 360)).toBeLessThan(360);
    expect(hueFromPoint(rect, 900)).toBeLessThan(360);
  });
});

describe("ColourSpectrum", () => {
  it("exposes both surfaces as keyboard-operable sliders", () => {
    const markup = renderToStaticMarkup(
      <ColourSpectrum hsv={{ h: 210, s: 0.4, v: 0.8 }} onChange={() => undefined} />,
    );
    expect(markup.match(/role="slider"/g)).toHaveLength(2);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Saturation and brightness"');
    expect(markup).toContain('aria-label="Hue"');
    expect(markup).toContain('aria-valuenow="210"');
    expect(markup).toContain('aria-valuenow="80"');
    expect(markup).toContain('aria-valuetext="Saturation 40%, brightness 80%"');
    expect(markup).toContain('aria-valuetext="210 degrees"');
  });
});
