import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { mutateCompareBackgroundTarget, mutateCompareLightingTarget } from "./comparisonTarget";

const doc = (): SceneDoc => ({
  version: 1,
  background: { type: "shader", shader: "mesh-gradient", colors: ["#111111", "#222222"] },
  backdrop: { type: "floor", color: "#111111" },
  lighting: { ambient: 0.4, preset: "base-lighting" },
  compare: { b: {} },
});

describe("comparison inspector targets", () => {
  it("changes After staging without freezing Before's background into an override", () => {
    const next = doc();
    mutateCompareBackgroundTarget(next, (target) => {
      target.backdrop = { type: "none" };
    });
    expect(next.background).toMatchObject({ type: "shader" });
    expect(next.backdrop).toEqual({ type: "floor", color: "#111111" });
    expect(next.compare?.b?.background).toBeUndefined();
    expect(next.compare?.b?.backdrop).toEqual({ type: "none" });
  });

  it("isolates nested After background edits from Before", () => {
    const next = doc();
    mutateCompareBackgroundTarget(next, (target) => {
      if (target.background?.type === "shader") target.background.colors?.splice(0, 1, "#abcdef");
    });
    expect(next.background).toMatchObject({ colors: ["#111111", "#222222"] });
    expect(next.compare?.b?.background).toMatchObject({ colors: ["#abcdef", "#222222"] });
  });

  it("starts a new After lighting override from Before's complete scene layer", () => {
    const next = doc();
    mutateCompareLightingTarget(next, (target) => {
      target.lighting = { ...target.lighting, ambient: 0.8 };
    });
    expect(next.lighting).toEqual({ ambient: 0.4, preset: "base-lighting" });
    expect(next.compare?.b?.lighting).toEqual({ ambient: 0.8, preset: "base-lighting" });
  });

  it("clears an After lighting override back to Before", () => {
    const next = doc();
    if (next.compare) next.compare.b = { lighting: { ambient: 0.8 } };
    mutateCompareLightingTarget(next, (target) => {
      delete target.lighting;
    });
    expect(next.lighting).toEqual({ ambient: 0.4, preset: "base-lighting" });
    expect(next.compare?.b?.lighting).toBeUndefined();
  });
});
