import { beforeEach, describe, expect, it } from "vitest";
import { useDecorationEditStore } from "./decorationEditStore";

const store = () => useDecorationEditStore.getState();

describe("decorationEditStore", () => {
  beforeEach(() => {
    useDecorationEditStore.setState({ sceneIndex: null, selectedId: null, mediaRequestId: null });
  });

  it("scopes a selection to the scene that was named", () => {
    store().setScene(2);
    store().select("dec1");
    expect(store().sceneIndex).toBe(2);
    expect(store().selectedId).toBe("dec1");
  });

  it("drops the selection when the scene changes", () => {
    store().setScene(2);
    store().select("dec1");
    store().setScene(3);
    expect(store().selectedId).toBeNull();
  });

  it("keeps the selection when the scene is re-named unchanged", () => {
    store().setScene(2);
    store().select("dec1");
    store().setScene(2);
    expect(store().selectedId).toBe("dec1");
  });

  it("leaves the media request alone across a scene change", () => {
    store().setScene(2);
    store().requestMedia("dec1");
    store().setScene(3);
    expect(store().mediaRequestId).toBe("dec1");
  });
});
