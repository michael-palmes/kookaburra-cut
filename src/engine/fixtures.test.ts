import { describe, expect, it } from "vitest";
import type { FixtureSpec } from "../theme/tokens";
import {
  assignFixtureLights,
  expandFixture,
  fixtureSeed,
  fixtureWorldInstances,
  resolveFixturePlan,
} from "./fixtures";
import { FIXTURE_MAX_COUNT } from "./sceneLighting";

const tube = (over: Partial<FixtureSpec> = {}): FixtureSpec => ({
  id: "corridor",
  form: "tube",
  size: [3.2, 0.06],
  emissive: 3.5,
  lightIntensity: 14,
  placement: { mode: "point", position: [0, 2.4, 0] },
  ...over,
});

describe("expandFixture", () => {
  it("a lone fixture is one instance at the origin", () => {
    const { instances, dropped } = expandFixture(tube());
    expect(instances).toEqual([{ offset: [0, 0, 0], emissiveScale: 1 }]);
    expect(dropped).toBe(0);
  });

  it("spaces the run centred along the axis", () => {
    const { instances } = expandFixture(tube({ repeat: { count: 4, spacing: 2, axis: "z" } }));
    expect(instances.map((i) => i.offset[2])).toEqual([-3, -1, 1, 3]);
    expect(instances.every((i) => i.offset[0] === 0 && i.offset[1] === 0)).toBe(true);
  });

  it("mirrors the whole run across the world plane (the two corridor rows are one entry)", () => {
    const { instances } = expandFixture(
      tube({
        placement: { mode: "point", position: [1.5, 2.4, 0] },
        repeat: { count: 2, spacing: 2, axis: "z", mirrorAxis: "x" },
      }),
    );
    expect(instances).toHaveLength(4);
    expect(instances.map((i) => i.offset[2])).toEqual([-1, 1, -1, 1]);
    // World x: base 1.5 + offsets -> [1.5, 1.5, -1.5, -1.5].
    expect(instances.map((i) => +(1.5 + i.offset[0]).toFixed(6))).toEqual([1.5, 1.5, -1.5, -1.5]);
  });

  it("jitter is deterministic from the fixture id and instance index", () => {
    const spec = tube({ repeat: { count: 8, spacing: 2.4, axis: "z", jitter: 0.4 } });
    const a = expandFixture(spec);
    const b = expandFixture(spec);
    expect(a.instances).toEqual(b.instances);
    // A different id re-rolls; the same id never does.
    const c = expandFixture({ ...spec, id: "other" });
    expect(c.instances).not.toEqual(a.instances);
    expect(a.instances.some((i) => i.emissiveScale !== 1)).toBe(true);
  });

  it("clamps the expanded total at FIXTURE_MAX_COUNT", () => {
    const { instances, dropped } = expandFixture(
      tube({ repeat: { count: 60, spacing: 1, axis: "z", mirrorAxis: "x" } }),
    );
    expect(instances).toHaveLength(FIXTURE_MAX_COUNT);
    expect(dropped).toBe(120 - FIXTURE_MAX_COUNT);
  });

  it("the jitter seed is pinned (export contract)", () => {
    expect(fixtureSeed("corridor")).toBe(fixtureSeed("corridor"));
    expect(fixtureSeed("corridor")).not.toBe(fixtureSeed("corridors"));
  });
});

describe("assignFixtureLights", () => {
  it("keeps every light inside the budget", () => {
    expect(assignFixtureLights(3, 8)).toEqual([true, true, true]);
  });

  it("thins every Nth over budget rather than lighting only the near end", () => {
    const lights = assignFixtureLights(8, 4);
    expect(lights).toEqual([true, false, true, false, true, false, true, false]);
    expect(assignFixtureLights(8, 0)).toEqual(new Array(8).fill(false));
    // 16 instances into 3 slots: stride 6 -> indices 0, 6, 12.
    const sparse = assignFixtureLights(16, 3);
    expect(sparse.filter(Boolean).length).toBe(3);
    expect(sparse[0] && sparse[6] && sparse[12]).toBe(true);
  });
});

describe("resolveFixturePlan", () => {
  it("assigns paired lights in declaration order and skips decorative fixtures", () => {
    const plan = resolveFixturePlan(
      [
        tube({ id: "a", repeat: { count: 6, spacing: 2, axis: "z" } }),
        tube({ id: "deco", lightIntensity: 0 }),
        tube({ id: "b", repeat: { count: 4, spacing: 2, axis: "z" } }),
      ],
      8,
    );
    expect(plan.entries[0].lights.filter(Boolean)).toHaveLength(6);
    expect(plan.entries[1].lights).toEqual([false]);
    // 2 slots left for b's 4 instances: thinned to every 2nd.
    expect(plan.entries[2].lights).toEqual([true, false, true, false]);
    expect(plan.thinnedLights).toBe(2);
  });

  it("drops disabled fixtures entirely", () => {
    const plan = resolveFixturePlan([tube({ enabled: false })], 8);
    expect(plan.entries).toHaveLength(0);
  });
});

describe("fixtureWorldInstances", () => {
  it("composes the base placement with the offsets (the env-mirror bake path)", () => {
    const world = fixtureWorldInstances(
      tube({
        placement: { mode: "point", position: [0, 2.4, 1] },
        repeat: { count: 2, spacing: 2, axis: "z" },
      }),
    );
    expect(world.map((w) => w.position)).toEqual([
      [0, 2.4, 0],
      [0, 2.4, 2],
    ]);
  });
});
