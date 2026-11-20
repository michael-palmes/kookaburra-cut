import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCameraVectors, serialiseCameraVectors } from "./cameraVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/camera-vectors.json",
    import.meta.url,
  ),
);

const vectors = buildCameraVectors();

describe("camera conformance vectors", () => {
  it("match the committed camera-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, serialiseCameraVectors(vectors));
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(vectors);
    expect(fresh, "camera-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("are unique, finite and cover kicks, dof, devices and both tracks", () => {
    const ids = vectors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = vectors.cases.flatMap((c) => c.poses.map((p) => p.expect));
    for (const pose of all) {
      for (const v of [...pose.position, ...pose.lookAt, pose.fov, pose.rollDeg]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(all.some((p) => p.dof?.mode === "lens")).toBe(true);
    expect(all.some((p) => p.dof?.mode === "depth")).toBe(true);
    expect(all.some((p) => p.rollDeg !== 0)).toBe(true);
    expect(vectors.cases.some((c) => c.devices.some((d) => d.expect.rotationDeg[1] !== 0))).toBe(
      true,
    );
  });
});
