import { describe, expect, it } from "vitest";
import {
  assertProjectRelative,
  assertUniqueSceneFiles,
  outgoingSceneTransitions,
  sceneMountKey,
} from "./project";
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

describe("assertUniqueSceneFiles", () => {
  const entry = (file: string) => ({ file, durationMs: 1000 });

  it("passes distinct files", () => {
    expect(() =>
      assertUniqueSceneFiles(
        [entry("scenes/01-open.tsx"), entry("scenes/02-close.tsx")],
        '"demo/project.json"',
      ),
    ).not.toThrow();
  });

  it("passes an empty scenes array", () => {
    expect(() => assertUniqueSceneFiles([], '"demo/project.json"')).not.toThrow();
  });

  it("throws naming the file and both scene positions", () => {
    expect(() =>
      assertUniqueSceneFiles(
        [entry("scenes/01-open.tsx"), entry("scenes/02-mid.tsx"), entry("scenes/01-open.tsx")],
        '"demo/project.json"',
      ),
    ).toThrow(/scenes\/01-open\.tsx.*scenes 1 and 3/);
  });

  it("catches a ./-prefixed spelling of the same file", () => {
    expect(() =>
      assertUniqueSceneFiles(
        [entry("scenes/01-open.tsx"), entry("./scenes/01-open.tsx")],
        '"demo/project.json"',
      ),
    ).toThrow(/more than once/);
  });
});

describe("sceneMountKey", () => {
  // The duplicate-spike fixture: eleven scenes whose TSX ids collide (four share "panel-6", two share "starter-title-2").
  const spikeFiles = [
    "scenes/01-app-version.tsx",
    "scenes/02-title.tsx",
    "scenes/03-device-video.tsx",
    "scenes/04-title-2.tsx",
    "scenes/05-device-camera.tsx",
    "scenes/06-app-version-end.tsx",
    "scenes/07-title-2-copy.tsx",
    "scenes/08-panel-6.tsx",
    "scenes/09-panel-6-copy.tsx",
    "scenes/10-panel-6-copy-copy.tsx",
    "scenes/11-panel-6-copy-copy-copy.tsx",
  ];
  const spikeIds = [
    "starter-app-version",
    "starter-title",
    "starter-device-video",
    "starter-title-2",
    "starter-device-camera",
    "starter-app-version-end",
    "starter-title-2",
    "panel-6",
    "panel-6",
    "panel-6",
    "panel-6",
  ];

  it("gives eleven colliding-id scenes eleven distinct keys", () => {
    expect(new Set(spikeIds).size).toBeLessThan(spikeFiles.length);
    const keys = spikeFiles.map((file) => sceneMountKey("ws:duplicate-spike", file));
    expect(new Set(keys).size).toBe(spikeFiles.length);
  });

  it("collapses the ./-prefixed spelling onto the same key", () => {
    expect(sceneMountKey("demo", "./scenes/x.tsx")).toBe(sceneMountKey("demo", "scenes/x.tsx"));
  });

  it("keys a file the same however the manifest orders it", () => {
    const key = (files: string[]) => files.map((f) => sceneMountKey("ws:duplicate-spike", f));
    const straight = key(spikeFiles);
    const shuffled = key([...spikeFiles].reverse());
    expect(shuffled).toEqual([...straight].reverse());
  });

  it("keeps one scene's base, side-B and panel mounts apart", () => {
    const base = sceneMountKey("demo", "scenes/08-panel-6.tsx");
    expect(new Set([base, `${base}:b`, `${base}:panel`]).size).toBe(3);
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
