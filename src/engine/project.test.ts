import { describe, expect, it } from "vitest";
import { assertProjectRelative, outgoingSceneTransitions } from "./project";
import type { TransitionSpec } from "./sceneTimeline";

describe("assertProjectRelative", () => {
  it("passes a legitimate assets path through unchanged", () => {
    expect(assertProjectRelative("assets/x.mp4")).toBe("assets/x.mp4");
  });

  it("strips a leading ./", () => {
    expect(assertProjectRelative("./assets/x.mp4")).toBe("assets/x.mp4");
  });

  it("rejects an empty string", () => {
    expect(() => assertProjectRelative("")).toThrow();
  });

  it("rejects a relative traversal that climbs out of the project", () => {
    expect(() => assertProjectRelative("../../etc/passwd")).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => assertProjectRelative("/etc/passwd")).toThrow();
  });

  it("rejects a .. segment buried after a legitimate-looking prefix", () => {
    expect(() => assertProjectRelative("assets/../../secret")).toThrow();
  });
});

describe("outgoingSceneTransitions (manifest v2 ownership flip)", () => {
  const cross: TransitionSpec = { type: "crossfade", durationMs: 500 };
  const wipe: TransitionSpec = { type: "wipe", durationMs: 300 };
  const scene = (transition?: TransitionSpec) => ({
    file: "scenes/x.tsx",
    durationMs: 1000,
    ...(transition ? { transition } : {}),
  });

  it("v2 manifests read transitions straight off each scene", () => {
    const out = outgoingSceneTransitions({
      version: 2,
      scenes: [scene(cross), scene(wipe), scene()],
    });
    expect(out).toEqual([cross, wipe, undefined]);
  });

  it("legacy manifests shift each incoming transition one scene earlier", () => {
    // Pre-v2 files stored the boundary spec on the INCOMING scene; the shift reproduces the identical timeline (the null-for-legacy proof).
    const out = outgoingSceneTransitions({
      scenes: [scene(), scene(cross), scene(wipe)],
    });
    expect(out).toEqual([cross, wipe, undefined]);
  });

  it("a legacy first-scene transition is meaningless and drops", () => {
    const out = outgoingSceneTransitions({ scenes: [scene(cross), scene()] });
    expect(out).toEqual([undefined, undefined]);
  });
});
