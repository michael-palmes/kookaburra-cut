import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EditOpErrorCode, EditOpName } from "../engine/editOps";
import { buildEditVectors, exportedEditFunctions, serialiseEditVectors } from "./editVectors";

const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/edit-vectors.json",
    import.meta.url,
  ),
);

const EM_DASH = "\u2014";
const vectors = buildEditVectors();
const text = serialiseEditVectors(vectors);

const OP_NAMES: Record<EditOpName, true> = {
  addClip: true,
  insertClip: true,
  split: true,
  freeze: true,
  removeClip: true,
  moveClip: true,
  setSpeed: true,
  trimIn: true,
  trimOut: true,
  setHold: true,
  setClipCrop: true,
  setZoomKey: true,
  removeZoomKey: true,
  setZoomKeyEase: true,
  moveZoomKey: true,
  addTap: true,
  addTapAtSource: true,
  moveTap: true,
  retimeTap: true,
  removeTap: true,
  setTapLook: true,
  addMask: true,
  setMaskRect: true,
  offsetMask: true,
  addMaskKey: true,
  removeMaskKey: true,
  retimeMaskEdge: true,
  setMaskLook: true,
  setMaskFade: true,
  removeMask: true,
};
const ERROR_CODES: Record<EditOpErrorCode, true> = {
  "no-clip": true,
  "no-split": true,
  "no-freeze": true,
  "unknown-clip": true,
  "unknown-tap": true,
  "unknown-mask": true,
  "unknown-source": true,
  "source-mismatch": true,
  "image-source": true,
  "no-change": true,
  "bad-arg": true,
};

function nonFinite(node: unknown, path = "$"): string[] {
  if (typeof node === "number") return Number.isFinite(node) ? [] : [path];
  if (node === undefined) return [path];
  if (Array.isArray(node)) return node.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) =>
      v === undefined ? [] : nonFinite(v, `${path}.${k}`),
    );
  }
  return [];
}

describe("edit conformance vectors", () => {
  it("matches the committed edit-vectors.json (run pnpm agent:vectors when this fails)", () => {
    if (process.env.KB_WRITE_VECTORS) {
      writeFileSync(VECTORS_PATH, text);
      return;
    }
    let committed: unknown = null;
    try {
      committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    } catch {
      committed = null;
    }
    const fresh = JSON.stringify(committed) === JSON.stringify(JSON.parse(text));
    expect(fresh, "edit-vectors.json is stale: run pnpm agent:vectors").toBe(true);
  });

  it("is deterministic, compact and one vector per line", () => {
    expect(serialiseEditVectors(buildEditVectors())).toBe(text);
    expect(Buffer.byteLength(text)).toBeLessThan(400_000);
    expect(text).not.toContain(EM_DASH);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(vectors.fns.length + vectors.ops.length + 5);
  });

  it("holds no non-finite or undefined values", () => {
    expect(nonFinite(vectors.fns.map((v) => [v.args, v.out]))).toEqual([]);
    expect(nonFinite(vectors.ops)).toEqual([]);
  });

  it("covers every editMath and editMasks export", () => {
    const covered = new Set(vectors.fns.map((v) => v.fn));
    expect(exportedEditFunctions().filter((fn) => !covered.has(fn))).toEqual([]);
    expect(Object.keys(vectors.constants)).toEqual(
      expect.arrayContaining(["MIN_CLIP_SOURCE_MS", "DEFAULT_HOLD_MS", "MASK_DEFAULT_SPAN_MS"]),
    );
  });

  it("succeeds and fails every op, and hits every error code", () => {
    const steps = vectors.ops.flatMap((v) => v.steps);
    const okOps = new Set(steps.filter((s) => s.ok).map((s) => s.op.op));
    const codes = new Set(steps.flatMap((s) => (s.code ? [s.code] : [])));
    expect(Object.keys(OP_NAMES).filter((op) => !okOps.has(op as EditOpName))).toEqual([]);
    expect(Object.keys(ERROR_CODES).filter((code) => !codes.has(code))).toEqual([]);
    for (const op of Object.keys(OP_NAMES)) {
      expect(
        steps.some((s) => s.op.op === op && !s.ok),
        `${op} has no failing step`,
      ).toBe(true);
    }
  });

  it("runs about a hundred seeded sequences with a healthy mix of outcomes", () => {
    const random = vectors.ops.filter((v) => v.id.startsWith("random/"));
    expect(random).toHaveLength(100);
    const steps = random.flatMap((v) => v.steps);
    const ok = steps.filter((s) => s.ok).length;
    expect(ok / steps.length).toBeGreaterThan(0.4);
    expect(ok / steps.length).toBeLessThan(0.95);
    const docs = random.map((v) => v.doc);
    expect(docs.some((d) => d.sources.some((s) => s.kind === "image"))).toBe(true);
    expect(docs.some((d) => d.clips.some((c) => c.holdMs !== undefined))).toBe(true);
    expect(docs.some((d) => d.clips.some((c) => ![1, 2].includes(c.speed)))).toBe(true);
    expect(docs.some((d) => (d.masks?.length ?? 0) > 0)).toBe(true);
    expect(docs.some((d) => (d.taps?.length ?? 0) > 0)).toBe(true);
  });

  it("runs seeded zoom sequences over zoomed docs", () => {
    const zoom = vectors.ops.filter((v) => v.id.startsWith("zoom-random/"));
    expect(zoom).toHaveLength(12);
    const steps = zoom.flatMap((v) => v.steps);
    const ok = steps.filter((s) => s.ok).length;
    expect(ok / steps.length).toBeGreaterThan(0.4);
    expect(ok / steps.length).toBeLessThan(0.95);
    expect(zoom.filter((v) => v.doc.clips.some((c) => c.zoom)).length).toBeGreaterThanOrEqual(8);
  });
});
