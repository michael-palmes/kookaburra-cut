import { Group } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { registerSceneHost, sceneHostsCommitted, unregisterSceneHost } from "./sceneHostRegistry";

const keys: string[] = [];

function host(key: string, index: number, opts: { side?: "b"; attached?: boolean } = {}): void {
  const group = new Group();
  if (opts.attached !== false) new Group().add(group);
  registerSceneHost(key, {
    index,
    id: `scenes/${index}.tsx`,
    startMs: 0,
    durationMs: 1000,
    group,
    side: opts.side,
  });
  keys.push(key);
}

afterEach(() => {
  for (const key of keys.splice(0)) unregisterSceneHost(key);
});

describe("sceneHostsCommitted", () => {
  it("waits for a primary host per slot", () => {
    host("a", 0);
    expect(sceneHostsCommitted(2)).toBe(false);
    host("b", 1);
    expect(sceneHostsCommitted(2)).toBe(true);
  });

  it("never counts a comparison side or a host that has left the graph", () => {
    host("a", 0);
    host("a-b", 0, { side: "b" });
    host("old", 1, { attached: false });
    expect(sceneHostsCommitted(2)).toBe(false);
  });
});
