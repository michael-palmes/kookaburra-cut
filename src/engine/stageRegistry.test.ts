import { beforeEach, describe, expect, it } from "vitest";
import { resolveSceneStageFloorSnapshot, useStageRegistry } from "./stageRegistry";

function resetRegistry(): void {
  useStageRegistry.setState({ registrations: {}, stages: {}, primaryStages: {} });
}

describe("stage registry comparison sides", () => {
  beforeEach(resetRegistry);

  it("keeps the primary custom floor when comparison B mounts without a floor", () => {
    const registry = useStageRegistry.getState();
    registry.register("a", {
      index: 0,
      backdropType: "floor",
      floorY: -0.8,
    });
    registry.register("b", {
      index: 0,
      side: "b",
      backdropType: "none",
      floorY: null,
    });

    expect(
      resolveSceneStageFloorSnapshot(1, useStageRegistry.getState().primaryStages, [0]),
    ).toEqual([-0.8]);
    expect(useStageRegistry.getState().stages[0]?.backdropType).toBe("floor");
  });

  it("keeps the primary floor through a custom B floor mount and B unmount", () => {
    const registry = useStageRegistry.getState();
    registry.register("a", {
      index: 0,
      backdropType: "floor",
      floorY: -0.8,
    });
    registry.register("b", {
      index: 0,
      side: "b",
      backdropType: "floor",
      floorY: -2.4,
    });

    expect(useStageRegistry.getState().primaryStages[0]?.floorY).toBe(-0.8);
    useStageRegistry.getState().unregister("b");
    expect(useStageRegistry.getState().primaryStages[0]?.floorY).toBe(-0.8);
    expect(useStageRegistry.getState().primaryStages[0]?.count).toBe(1);
  });

  it("retains any-side backdrop warnings without leaving B state after unmount", () => {
    const registry = useStageRegistry.getState();
    registry.register("a", {
      index: 0,
      backdropType: "none",
      floorY: null,
    });
    registry.register("b", {
      index: 0,
      side: "b",
      backdropType: "floor",
      floorY: -2.4,
    });

    expect(useStageRegistry.getState().stages[0]?.backdropType).toBe("floor");
    useStageRegistry.getState().unregister("b");
    expect(useStageRegistry.getState().stages[0]).toEqual({
      count: 1,
      backdropType: "none",
      floorY: null,
    });
  });
});
