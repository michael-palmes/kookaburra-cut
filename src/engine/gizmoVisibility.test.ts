import { Object3D } from "three";
import { describe, expect, it } from "vitest";
import { nodeDrawn } from "./gizmoVisibility";

function chain(depth: number): Object3D[] {
  const nodes: Object3D[] = [];
  for (let i = 0; i < depth; i++) {
    const node = new Object3D();
    if (i > 0) nodes[i - 1].add(node);
    nodes.push(node);
  }
  return nodes;
}

describe("nodeDrawn", () => {
  it("is true when every ancestor is visible", () => {
    const nodes = chain(4);
    expect(nodeDrawn(nodes[3])).toBe(true);
  });

  it("is false when any ancestor anywhere up the chain is hidden", () => {
    const nodes = chain(4);
    nodes[0].visible = false;
    expect(nodeDrawn(nodes[3])).toBe(false);
    nodes[0].visible = true;
    nodes[2].visible = false;
    expect(nodeDrawn(nodes[3])).toBe(false);
  });

  it("ignores the node's own visibility (an invisible hit mesh is still drawn-in-context)", () => {
    const nodes = chain(2);
    nodes[1].visible = false;
    expect(nodeDrawn(nodes[1])).toBe(true);
  });

  it("stops at the given ancestor, so a hidden panel group above it does not count", () => {
    const nodes = chain(4);
    nodes[0].visible = false;
    expect(nodeDrawn(nodes[3], nodes[1])).toBe(true);
    nodes[2].visible = false;
    expect(nodeDrawn(nodes[3], nodes[1])).toBe(false);
  });

  it("is false for a missing node", () => {
    expect(nodeDrawn(null)).toBe(false);
    expect(nodeDrawn(undefined)).toBe(false);
  });
});
