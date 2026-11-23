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
const TOLERANCE = 1e-9;

function firstDifference(want: unknown, got: unknown, path: string): string | null {
  const shown = (v: unknown) => JSON.stringify(v);
  if (typeof want === "number" && typeof got === "number") {
    if (Number.isInteger(want) && Number.isInteger(got)) {
      return want === got ? null : `${path}: ${want} committed, ${got} now`;
    }
    const close = Math.abs(want - got) <= TOLERANCE * Math.max(1, Math.abs(want));
    return close ? null : `${path}: ${want} committed, ${got} now`;
  }
  if (Array.isArray(want) || Array.isArray(got)) {
    if (!Array.isArray(want) || !Array.isArray(got) || want.length !== got.length) {
      return `${path}: ${shown(want)?.slice(0, 80)} committed, ${shown(got)?.slice(0, 80)} now`;
    }
    for (let i = 0; i < want.length; i++) {
      const diff = firstDifference(want[i], got[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (want && got && typeof want === "object" && typeof got === "object") {
    const wantKeys = Object.keys(want);
    const gotKeys = Object.keys(got);
    if (wantKeys.join("\0") !== gotKeys.join("\0")) {
      return `${path}: keys ${wantKeys.join(",")} committed, ${gotKeys.join(",")} now`;
    }
    for (const key of wantKeys) {
      const diff = firstDifference(
        (want as Record<string, unknown>)[key],
        (got as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }
  return want === got ? null : `${path}: ${shown(want)} committed, ${shown(got)} now`;
}

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
    const diff = firstDifference(committed, JSON.parse(JSON.stringify(vectors)), "vectors");
    expect(diff, "camera-vectors.json is stale: run pnpm agent:vectors").toBeNull();
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
