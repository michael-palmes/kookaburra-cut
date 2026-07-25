import type { FixtureSpec } from "../theme/tokens";
import { placementPosition } from "./orbit";
import { createSeededRandom } from "./rng";
import { FIXTURE_MAX_COUNT } from "./sceneLighting";

/** Fixture repeat expansion: pure math shared by the stage renderer, the env-mirror bake and the tests. Instances are OFFSETS from the fixture origin (the group carries the placement, so camera/subject-space fixtures resolve at the seam untouched); jitter draws from the seeded PRNG keyed on the fixture id + instance index, never Math.random (the sequence is export contract). */

export interface FixtureInstance {
  /** Offset from the fixture origin, world units. */
  offset: [number, number, number];
  /** 1 = the authored emissive; jitter varies this by up to ±jitter/2. */
  emissiveScale: number;
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/** djb2 over the fixture id: the jitter seed. EXPORT CONTRACT (a different hash re-rolls every jittered corridor). */
export function fixtureSeed(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return h;
}

/** Expand a fixture's repeat block into instance offsets: `count` spaced along `axis` centred on the fixture origin, jittered per instance, then the whole run duplicated mirrored across `mirrorAxis` (the WORLD plane through zero in the fixture's own space, so a run based at x 1.5 mirrors to x -1.5: the two corridor rows are one entry). The total clamps to FIXTURE_MAX_COUNT; `dropped` counts what the clamp removed, for the caller to warn about. */
export function expandFixture(spec: FixtureSpec): {
  instances: FixtureInstance[];
  dropped: number;
} {
  const repeat = spec.repeat;
  const base = placementPosition(spec.placement);
  const run: FixtureInstance[] = [];
  if (!repeat || repeat.count <= 1) {
    run.push({ offset: [0, 0, 0], emissiveScale: 1 });
  } else {
    const axis = AXIS_INDEX[repeat.axis];
    const jitter = repeat.jitter ?? 0;
    for (let i = 0; i < repeat.count; i++) {
      const offset: [number, number, number] = [0, 0, 0];
      offset[axis] = (i - (repeat.count - 1) / 2) * repeat.spacing;
      let emissiveScale = 1;
      if (jitter > 0) {
        const rng = createSeededRandom(fixtureSeed(spec.id) + i);
        offset[axis] += (rng() - 0.5) * jitter * repeat.spacing;
        emissiveScale = 1 + (rng() - 0.5) * jitter;
      }
      run.push({ offset, emissiveScale });
    }
  }
  const mirrorAxis = repeat?.mirrorAxis;
  const instances = mirrorAxis
    ? [...run, ...run.map((inst) => mirrored(inst, mirrorAxis, base))]
    : run;
  const dropped = Math.max(0, instances.length - FIXTURE_MAX_COUNT);
  return { instances: instances.slice(0, FIXTURE_MAX_COUNT), dropped };
}

/** Mirror one instance across the axis plane at zero IN THE FIXTURE'S SPACE: world = base + offset flips to -(base + offset), stored back as an offset from the same base. */
function mirrored(
  inst: FixtureInstance,
  axis: "x" | "y" | "z",
  base: [number, number, number],
): FixtureInstance {
  const i = AXIS_INDEX[axis];
  const offset: [number, number, number] = [...inst.offset];
  offset[i] = -(base[i] + inst.offset[i]) - base[i];
  return { offset, emissiveScale: inst.emissiveScale };
}

/** Which instances keep their paired light under a budget: all of them when they fit, else every Nth in declaration order (a corridor lit every second tube looks fine; a corridor lit only at the near end looks broken). */
export function assignFixtureLights(instanceCount: number, budget: number): boolean[] {
  if (budget <= 0) return new Array(instanceCount).fill(false);
  if (instanceCount <= budget) return new Array(instanceCount).fill(true);
  const stride = Math.ceil(instanceCount / budget);
  return Array.from({ length: instanceCount }, (_, i) => i % stride === 0);
}

export interface FixturePlanEntry {
  spec: FixtureSpec;
  instances: FixtureInstance[];
  /** Per instance: whether its paired light mounts (deterministic thinning under the scene cap). */
  lights: boolean[];
}

/** The scene's fixture render plan: enabled fixtures expanded, paired lights assigned from the remaining scene-light budget in declaration order (identical in preview and export). */
export function resolveFixturePlan(
  fixtures: readonly FixtureSpec[] | undefined,
  lightBudget: number,
): { entries: FixturePlanEntry[]; droppedInstances: number; thinnedLights: number } {
  const entries: FixturePlanEntry[] = [];
  let remaining = Math.max(0, lightBudget);
  let droppedInstances = 0;
  let thinnedLights = 0;
  for (const spec of fixtures ?? []) {
    if (spec.enabled === false) continue;
    const { instances, dropped } = expandFixture(spec);
    droppedInstances += dropped;
    let lights: boolean[];
    if (spec.lightIntensity > 0) {
      lights = assignFixtureLights(instances.length, remaining);
      const used = lights.filter(Boolean).length;
      thinnedLights += instances.length - used;
      remaining -= used;
    } else {
      lights = new Array(instances.length).fill(false);
    }
    entries.push({ spec, instances, lights });
  }
  return { entries, droppedInstances, thinnedLights };
}

/** The world-space pose of each instance for a WORLD fixture (base placement + offsets): the env-mirror bake and the helpers read this; the renderer keeps offsets under a placed group instead. */
export function fixtureWorldInstances(
  spec: FixtureSpec,
): { position: [number, number, number]; emissiveScale: number }[] {
  const base = placementPosition(spec.placement);
  return expandFixture(spec).instances.map((inst) => ({
    position: [base[0] + inst.offset[0], base[1] + inst.offset[1], base[2] + inst.offset[2]],
    emissiveScale: inst.emissiveScale,
  }));
}
