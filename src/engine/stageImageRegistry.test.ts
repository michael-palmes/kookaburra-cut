import { beforeEach, describe, expect, it } from "vitest";
import { useStageImageRegistry } from "./stageImageRegistry";

describe("stageImageRegistry", () => {
  beforeEach(() => useStageImageRegistry.setState({ consumers: {} }));

  it("counts staged consumers independently by scene", () => {
    const registry = useStageImageRegistry.getState();
    registry.register(1);
    registry.register(1);
    registry.register(2);

    expect(useStageImageRegistry.getState().consumers).toEqual({ 1: 2, 2: 1 });
  });

  it("drops a scene only after its last staged consumer unmounts", () => {
    const registry = useStageImageRegistry.getState();
    registry.register(3);
    registry.register(3);
    registry.unregister(3);
    expect(useStageImageRegistry.getState().consumers).toEqual({ 3: 1 });

    registry.unregister(3);
    expect(useStageImageRegistry.getState().consumers).toEqual({});
  });
});
