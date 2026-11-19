import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneDocDof } from "../../engine/dof";
import { DofFields, type DofKeyView, dofModeSwitch } from "./DofFields";

const track = (...dofs: (SceneDocDof | undefined)[]): DofKeyView[] =>
  dofs.map((dof, i) => ({ id: `k${i + 1}`, tMs: i * 1000, pose: dof ? { dof } : {} }));

const switched = (keys: DofKeyView[], next: Parameters<typeof dofModeSwitch>[1]) => {
  const map = dofModeSwitch(keys, next);
  return keys.map((key) => map(key.pose.dof, key.id));
};

describe("dofModeSwitch", () => {
  it("leaves later keys' blur to carry forward when leaving lens", () => {
    const keys = track({ mode: "lens", blur: 0 }, { focus: 3 }, { blur: 1 });
    expect(switched(keys, "depth")).toEqual([
      { mode: "depth", blur: 0 },
      { mode: "depth", focus: 3 },
      { mode: "depth", blur: 1 },
    ]);
  });

  it("gives only the first dof key a fallback blur when it has none", () => {
    const keys = track(undefined, { mode: "lens", fStop: 2.8, sensorMm: 24 }, { focus: 3 });
    expect(switched(keys, "tilt")).toEqual([
      undefined,
      { mode: "tilt", blur: 0.5 },
      { mode: "tilt", focus: 3 },
    ]);
  });

  it("finds the first key by time, not by array order", () => {
    const keys: DofKeyView[] = [
      { id: "late", tMs: 2000, pose: { dof: { focus: 3 } } },
      { id: "early", tMs: 0, pose: { dof: { mode: "lens" } } },
    ];
    expect(switched(keys, "depth")).toEqual([
      { mode: "depth", focus: 3 },
      { mode: "depth", blur: 0.5 },
    ]);
  });

  it("drops depth's blur and range on the way into lens", () => {
    const keys = track({ mode: "depth", blur: 0.6, range: 1.2, focus: 2 }, { blur: 0.9 });
    expect(switched(keys, "lens")).toEqual([{ mode: "lens", focus: 2 }, { mode: "lens" }]);
  });

  it("adds no blur when switching between other families", () => {
    const keys = track({ mode: "depth", focus: 2 }, { blur: 0.4 });
    expect(switched(keys, "split")).toEqual([
      { mode: "split", focus: 2 },
      { mode: "split", blur: 0.4 },
    ]);
  });
});

describe("DofFields carry", () => {
  it("shows the mode an earlier key set on a key with no dof of its own", () => {
    const html = renderToStaticMarkup(
      createElement(DofFields, {
        keys: track({ mode: "lens", fStop: 2 }, undefined),
        targetKeyId: "k2",
        authored: undefined,
        autoDistance: 4,
        autoLabel: "the aim",
        preview: () => {},
        commit: () => {},
        commitAll: () => {},
      }),
    );
    expect(html).toMatch(/class="chip selected" title="A real lens/);
    expect(html).toContain("f-stop");
  });
});
