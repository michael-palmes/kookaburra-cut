import { beforeEach, describe, expect, it } from "vitest";
import { useSceneMediaRegistry } from "./sceneMediaRegistry";

describe("sceneMediaRegistry", () => {
  beforeEach(() => useSceneMediaRegistry.setState({ consumers: {} }));

  it("counts consumers independently by scene and family", () => {
    const registry = useSceneMediaRegistry.getState();
    registry.register(1, "stage");
    registry.register(1, "stage");
    registry.register(1, "window");
    registry.register(2, "stage");

    expect(useSceneMediaRegistry.getState().consumers).toEqual({
      "1:stage": 2,
      "1:window": 1,
      "2:stage": 1,
    });
  });

  it("drops a family only after its last consumer unmounts", () => {
    const registry = useSceneMediaRegistry.getState();
    registry.register(3, "window");
    registry.register(3, "window");
    registry.unregister(3, "window");
    expect(useSceneMediaRegistry.getState().consumers).toEqual({ "3:window": 1 });

    registry.unregister(3, "window");
    expect(useSceneMediaRegistry.getState().consumers).toEqual({});
  });
});
