import { Matrix4, Object3D, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { type ChartLabelBeforeRender, chartLabelBeforeRender } from "./billboardLabel";

/** A stand-in for troika's `Text`: the CLASS owns `onBeforeRender` (glyph sync plus SDF-atlas binding), which is exactly the method a bare handler prop shadows. */
class FakeTextMesh extends Object3D {
  syncs = 0;
  args: unknown[] = [];
  onBeforeRender(...args: unknown[]) {
    this.syncs++;
    this.args = args;
  }
}

const RENDERER = "renderer";
const GROUP = "group";

const call = (handler: ChartLabelBeforeRender, camera: Object3D) =>
  handler(
    ...([
      RENDERER,
      "scene",
      camera,
      "geometry",
      "material",
      GROUP,
    ] as unknown as Parameters<ChartLabelBeforeRender>),
  );

describe("chartLabelBeforeRender", () => {
  it("runs the label's own class handler, which the prop shadows", () => {
    const label = new FakeTextMesh();
    const handler = chartLabelBeforeRender(
      () => new Object3D(),
      () => label,
      0,
    );
    // r3f applies the prop as an own property, shadowing the class method: the label must still sync.
    (label as { onBeforeRender: unknown }).onBeforeRender = handler;
    call(label.onBeforeRender as ChartLabelBeforeRender, new Object3D());
    expect(label.syncs).toBe(1);
    expect(label.args[0]).toBe(RENDERER);
    expect(label.args[5]).toBe(GROUP);
  });

  it("faces the label at the render camera about the anchor", () => {
    const label = new FakeTextMesh();
    const anchor = new Object3D();
    anchor.position.set(1.5, -2, 0.25);
    anchor.updateMatrixWorld(true);
    const camera = new Object3D();
    camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    call(
      chartLabelBeforeRender(
        () => anchor,
        () => label,
        0,
      ),
      camera,
    );
    const expected = new Matrix4().compose(
      new Vector3(1.5, -2, 0.25),
      camera.quaternion,
      new Vector3(1, 1, 1),
    );
    expect(label.matrixWorld.elements).toEqual(expected.elements);
  });

  it("is a pure function of the frame: the same camera twice gives the same matrix", () => {
    const label = new FakeTextMesh();
    const camera = new Object3D();
    camera.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const handler = chartLabelBeforeRender(
      () => new Object3D(),
      () => label,
      Math.PI / 2,
    );
    call(handler, camera);
    const first = label.matrixWorld.clone();
    call(handler, camera);
    expect(label.matrixWorld.elements).toEqual(first.elements);
  });

  it("still syncs, and leaves the matrix alone, while the anchor is unmounted", () => {
    const label = new FakeTextMesh();
    const before = label.matrixWorld.clone();
    call(
      chartLabelBeforeRender(
        () => null,
        () => label,
        0,
      ),
      new Object3D(),
    );
    expect(label.syncs).toBe(1);
    expect(label.matrixWorld.elements).toEqual(before.elements);
  });

  it("does nothing before the label mounts", () => {
    const handler = chartLabelBeforeRender(
      () => new Object3D(),
      () => null,
      0,
    );
    expect(() => call(handler, new Object3D())).not.toThrow();
  });
});
