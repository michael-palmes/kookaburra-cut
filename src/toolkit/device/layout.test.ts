import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import type { SceneDocDeviceLayout } from "../../engine/sceneDocSchema";
import { resolveDeviceLayout } from "./layout";

const wide = computeFormat(FORMATS["16:9"]);
const tall = computeFormat(FORMATS["9:16"]);

const phones = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, model: "iphone-17-pro" }));

const layout = (parts: Partial<SceneDocDeviceLayout> = {}): SceneDocDeviceLayout => ({
  preset: "row",
  ...parts,
});

describe("resolveDeviceLayout", () => {
  it("a row is symmetric with the authored edge-to-edge gap", () => {
    const [a, b] = resolveDeviceLayout(phones(2), layout({ gap: 0.4 }), wide);
    expect(a.position?.[0]).toBeCloseTo(-(b.position?.[0] ?? 0));
    // Equal widths: centre distance = one device width (at base scale) + the gap.
    expect((b.position?.[0] ?? 0) - (a.position?.[0] ?? 0)).toBeCloseTo(1.25 * 0.92 + 0.4);
    expect(a.rotationDeg).toEqual([0, 0, 0]);
    expect(a.scale).toBeCloseTo(0.92);
  });

  it("toe-in yaws outer devices toward centre with opposing signs", () => {
    const [a, b, c] = resolveDeviceLayout(phones(3), layout({ preset: "toe-in" }), wide);
    expect(a.rotationDeg?.[1]).toBeGreaterThan(0);
    expect(b.rotationDeg?.[1]).toBeCloseTo(0);
    expect(c.rotationDeg?.[1]).toBeCloseTo(-(a.rotationDeg?.[1] ?? 0));
  });

  it("arc recedes outer devices and keeps the centre forward", () => {
    const [a, b, c] = resolveDeviceLayout(phones(3), layout({ preset: "arc" }), wide);
    expect(b.position?.[2]).toBeCloseTo(0);
    expect(a.position?.[2]).toBeLessThan(0);
    expect(a.position?.[2]).toBeCloseTo(c.position?.[2] ?? 0);
  });

  it("hero puts device 1 forward at full scale, wings behind and smaller", () => {
    const [hero, w1, w2] = resolveDeviceLayout(phones(3), layout({ preset: "hero" }), wide);
    expect(hero.position?.[0]).toBeCloseTo(0);
    expect(hero.position?.[2]).toBeGreaterThan(0);
    expect(w1.position?.[2]).toBeLessThan(0);
    expect(w1.scale).toBeLessThan(hero.scale ?? 1);
    expect(Math.sign(w1.position?.[0] ?? 0)).toBe(-Math.sign(w2.position?.[0] ?? 0));
  });

  it("depth-pair splits front and back; any other count falls back to toe-in", () => {
    const [front, back] = resolveDeviceLayout(phones(2), layout({ preset: "depth-pair" }), wide);
    expect(front.position?.[2]).toBeGreaterThan(0);
    expect(back.position?.[2]).toBeLessThan(0);
    const three = resolveDeviceLayout(phones(3), layout({ preset: "depth-pair" }), wide);
    expect(three[2].position?.[2]).toBeCloseTo(0);
    expect(three[0].rotationDeg?.[1]).toBeGreaterThan(0);
  });

  it("a narrow aspect compresses positions and scales together, wide does not", () => {
    const wideRow = resolveDeviceLayout(phones(2), layout(), wide);
    const tallRow = resolveDeviceLayout(phones(2), layout(), tall);
    expect(wideRow[0].scale).toBeCloseTo(0.92);
    expect(tallRow[0].scale ?? 1).toBeLessThan(wideRow[0].scale ?? 1);
    const ratioX = (tallRow[0].position?.[0] ?? 0) / (wideRow[0].position?.[0] ?? 1);
    const ratioS = (tallRow[0].scale ?? 1) / (wideRow[0].scale ?? 1);
    expect(ratioX).toBeCloseTo(ratioS);
  });

  it("deltas add to position and rotation, multiply scale, and never move neighbours", () => {
    const base = resolveDeviceLayout(phones(2), layout({ preset: "toe-in" }), wide);
    const nudged = resolveDeviceLayout(
      phones(2),
      layout({
        preset: "toe-in",
        devices: { d2: { offset: [0.1, 0.2, -0.3], rotationDeg: [5, -4, 3], scale: 1.5 } },
      }),
      wide,
    );
    expect(nudged[0]).toEqual(base[0]);
    expect(nudged[1].position?.[0]).toBeCloseTo((base[1].position?.[0] ?? 0) + 0.1);
    expect(nudged[1].position?.[1]).toBeCloseTo((base[1].position?.[1] ?? 0) + 0.2);
    expect(nudged[1].position?.[2]).toBeCloseTo((base[1].position?.[2] ?? 0) - 0.3);
    expect(nudged[1].rotationDeg?.[0]).toBeCloseTo(5);
    expect(nudged[1].rotationDeg?.[1]).toBeCloseTo((base[1].rotationDeg?.[1] ?? 0) - 4);
    expect(nudged[1].rotationDeg?.[2]).toBeCloseTo(3);
    expect(nudged[1].scale).toBeCloseTo((base[1].scale ?? 1) * 1.5);
  });

  it("mixed models keep the authored gap edge to edge", () => {
    const pair = [
      { id: "d1", model: "iphone-17-pro" },
      { id: "d2", model: "macbook-pro-16" },
    ];
    const [phone, laptop] = resolveDeviceLayout(pair, layout({ gap: 0.3 }), wide);
    const centreGap = (laptop.position?.[0] ?? 0) - (phone.position?.[0] ?? 0);
    // Half of each width (at base scale) plus the gap; this pair fits 16:9 unscaled.
    expect(phone.scale).toBeCloseTo(0.92);
    expect(centreGap).toBeCloseTo(((1.25 + 3.4) / 2) * 0.92 + 0.3);
  });

  it("an unknown model uses the fallback width; ground passes through; one device centres", () => {
    const [only] = resolveDeviceLayout(
      [{ id: "d1", model: "mystery", placement: { ground: true } }],
      layout(),
      wide,
    );
    expect(only.position?.[0]).toBeCloseTo(0);
    expect(only.position?.[1]).toBeCloseTo(-0.3);
    expect(only.ground).toBe(true);
    expect(only.scale).toBeCloseTo(0.92);
    expect(resolveDeviceLayout([], layout(), wide)).toEqual([]);
  });
});
