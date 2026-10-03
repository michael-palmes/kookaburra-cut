import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { createInstanceScratch } from "../../kit/instanced";
import { lookMaterialProblem } from "../../kit/material";
import { frostedRimSeats, look, presets } from "./index";
import { FROSTED, frostedLayout, lampPosition, panePose } from "./panes";
import { CORE_FRAGMENT, FLOOR_FRAGMENT, PANE_FRAGMENT, PANE_VERTEX } from "./shaders";

describe("frosted panes layout", () => {
  it("is seeded, capped at the mounted capacities and leaves gaps round the ring", () => {
    expect(frostedLayout(22, 5, 12.5)).toEqual(frostedLayout(22, 5, 12.5));
    const big = frostedLayout(99, 99, 12.5);
    expect(big.panes).toHaveLength(FROSTED.maxPanes);
    expect(big.lamps).toHaveLength(FROSTED.maxLamps);
    expect(look.params.paneCount.max).toBe(FROSTED.maxPanes);
    expect(look.params.lampCount.max).toBe(FROSTED.maxLamps);
    for (const count of [10, 22, 32]) {
      const { panes } = frostedLayout(count, 5, 12.5);
      const covered = panes.reduce((sum, p) => sum + p.width / p.radius, 0);
      expect(covered / (2 * Math.PI)).toBeLessThan(0.85);
      for (const p of panes) {
        expect(p.radius).toBeGreaterThanOrEqual(11);
        expect(p.radius).toBeLessThanOrEqual(14);
        expect(p.height).toBeGreaterThanOrEqual(5);
        expect(p.height).toBeLessThanOrEqual(10.5);
      }
    }
  });

  it("faces every pane's front at the stage axis with a positive determinant (FrontSide cutaway)", () => {
    const scratch = createInstanceScratch();
    const m = new Matrix4();
    for (const p of frostedLayout(22, 5, 12.5).panes) {
      panePose(p, 0, scratch.pose);
      m.compose(
        scratch.pose.position,
        new Quaternion().setFromEuler(scratch.pose.rotation),
        scratch.pose.scale,
      );
      expect(m.determinant()).toBeGreaterThan(0);
      const normal = new Vector3(0, 0, 1).transformDirection(m);
      const toAxis = new Vector3(-scratch.pose.position.x, 0, -scratch.pose.position.z).normalize();
      expect(normal.dot(toAxis)).toBeCloseTo(1, 6);
    }
  });

  it("loops every lamp exactly at 60 s, outside the ring and above the text band", () => {
    const a = new Vector3();
    const b = new Vector3();
    for (const ring of [10, 12.5, 18]) {
      for (const lamp of frostedLayout(22, 8, ring).lamps) {
        expect(
          Number.isInteger(lamp.a) && Number.isInteger(lamp.b) && Number.isInteger(lamp.c),
        ).toBe(true);
        for (let t = 0; t < 60; t += 1.7) {
          lampPosition(lamp, ring, t, a);
          lampPosition(lamp, ring, t + 600, b);
          expect(a.distanceTo(b)).toBeLessThan(1e-9);
          expect(Math.hypot(a.x, a.z)).toBeGreaterThanOrEqual(ring + 3 - 1e-9);
          expect(a.y).toBeGreaterThanOrEqual(5.5 - 1e-9);
          expect(a.y).toBeLessThanOrEqual(7.5 + 1e-9);
        }
      }
    }
  });
});

describe("frosted panes presets", () => {
  it("carry a cheap companion rig whose warm rims sit behind the stage in the Lamp colour", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      const seats = frostedRimSeats(p.params ?? {});
      expect(p.lighting?.lights?.length, p.id).toBe(seats.length);
      expect(seats.length, p.id).toBeGreaterThan(0);
      for (const light of p.lighting?.lights ?? []) {
        expect(light.color, p.id).toBe(p.colors[3]);
        if (light.placement.mode !== "orbit") throw new Error("orbit placement expected");
        expect(Math.abs(light.placement.azimuthDeg), p.id).toBeGreaterThan(90);
      }
    }
  });

  it("keep rain off by default, a param only", () => {
    expect(look.params.rain.default).toBe(0);
    for (const p of presets) expect(p.params?.rain, p.id).toBe(0);
  });

  it("build sound look materials", () => {
    const specs: [string, string, string?][] = [
      ["pane", PANE_FRAGMENT, PANE_VERTEX],
      ["core", CORE_FRAGMENT],
      ["floor", FLOOR_FRAGMENT],
    ];
    for (const [part, fragmentShader, vertexShader] of specs) {
      expect(
        lookMaterialProblem({ key: `frosted-panes/${part}`, fragmentShader, vertexShader }),
        part,
      ).toBeNull();
    }
  });
});
