import { describe, expect, it } from "vitest";
import { checkCameraBounds, stagedBackdrop } from "./cameraBounds";
import type { CameraPose } from "./cameraTrack";
import type { SceneDoc } from "./sceneDocSchema";

const ASPECT = 16 / 9;
const base: CameraPose = { position: [0, 0, 5], lookAt: [0, 0, 0], fov: 45 };
const floorDoc: SceneDoc = { version: 1, backdrop: { type: "floor", color: "#1b2030" } };

describe("checkCameraBounds", () => {
  it("passes anything when the scene stages nothing", () => {
    expect(checkCameraBounds(base, ASPECT, { version: 1 }).ok).toBe(true);
    expect(checkCameraBounds({ ...base, position: [90, 40, 60] }, ASPECT, { version: 1 }).ok).toBe(
      true,
    );
  });

  it("passes the base pose over a staged cyclorama", () => {
    expect(checkCameraBounds(base, ASPECT, floorDoc).ok).toBe(true);
  });

  it("warns when the camera leaves the cyclorama volume", () => {
    const outside = { ...base, position: [0, 0, 20] as [number, number, number] };
    const verdict = checkCameraBounds(outside, ASPECT, floorDoc);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/outside the staged cyclorama/);
  });

  it("passes a shot whose lower frame edge lands on the cyc FLOOR (not the wall)", () => {
    // The plane-only version of this check called the base framing out of bounds.
    const down = { ...base, lookAt: [0, -1.2, 0] as [number, number, number] };
    expect(checkCameraBounds(down, ASPECT, floorDoc).ok).toBe(true);
  });

  it("warns when the wall's side edge would come into frame", () => {
    const wide = {
      ...base,
      position: [18, 0, 4] as [number, number, number],
      lookAt: [18, 0, 0] as [number, number, number],
    };
    const verdict = checkCameraBounds(wide, ASPECT, floorDoc);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/edge comes into frame/);
  });

  it("warns when the frame runs off the floor's front edge", () => {
    const forward = {
      ...base,
      position: [0, 2, 8] as [number, number, number],
      lookAt: [0, -1, 12] as [number, number, number],
    };
    const verdict = checkCameraBounds(forward, ASPECT, floorDoc);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/edge comes into frame/);
  });

  it("checks a vertical backdrop plane on its own extents", () => {
    const doc: SceneDoc = { version: 1, backdrop: { type: "gradient", gradient: "dusk" } };
    expect(checkCameraBounds(base, ASPECT, doc).ok).toBe(true);
    const tilted = {
      ...base,
      lookAt: [0, 14, -6] as [number, number, number],
    };
    expect(checkCameraBounds(tilted, ASPECT, doc).ok).toBe(false);
  });

  it("a video window follows the scene's own staging rules, not special ones", () => {
    const doc: SceneDoc = {
      version: 1,
      videoWindow: { media: { src: "assets/a.mp4" }, radius: "macos" },
    };
    // Nothing staged: always ok, even from far away.
    const far = {
      ...base,
      position: [7, 0, 5] as [number, number, number],
      lookAt: [7, 0, 0] as [number, number, number],
    };
    expect(checkCameraBounds(base, ASPECT, doc).ok).toBe(true);
    expect(checkCameraBounds(far, ASPECT, doc).ok).toBe(true);
    // A staged backdrop behind the window is checked exactly like any other scene's.
    const staged: SceneDoc = { ...doc, backdrop: { type: "gradient", gradient: "dusk" } };
    expect(checkCameraBounds(base, ASPECT, staged).ok).toBe(true);
    const tilted = { ...base, lookAt: [0, 14, -6] as [number, number, number] };
    expect(checkCameraBounds(tilted, ASPECT, staged).ok).toBe(false);
  });

  it("the scene's own backdrop beats the theme's, and none cancels it", () => {
    expect(stagedBackdrop({ version: 1 }, { type: "floor", color: "#000" })?.type).toBe("floor");
    expect(stagedBackdrop(floorDoc, { type: "gradient", gradient: "x" })?.type).toBe("floor");
    expect(
      stagedBackdrop({ version: 1, backdrop: { type: "none" } }, { type: "floor", color: "#000" }),
    ).toBeUndefined();
  });
});
