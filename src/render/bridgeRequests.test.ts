import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lastLoadReport } from "../engine/appHeartbeat";
import { FORMATS } from "../engine/format";
import type { LoadedProject } from "../engine/project";
import { TrustDeniedError } from "../engine/projectTrust";
import type { SceneDoc } from "../engine/sceneDocSchema";
import {
  BRIDGE_KINDS,
  type BridgeRequest,
  buildCheckReport,
  captureFormat,
  collectAssetRefs,
  frameScene,
  isNativeBridgeKind,
  MAX_CAPTURE_FRAMES,
  MAX_PROBES,
  NATIVE_BRIDGE_KINDS,
  parseProbes,
  requestCaptureFormat,
  requestFormat,
  requestFrames,
  resolvePresetRef,
  responseVersion,
  samplePixels,
  trustDeniedSlug,
  trustSentence,
  unitsFor,
} from "./bridgeRequests";
import { contactSheetLayout, tileOrigin } from "./contactSheet";

describe("capture sizing", () => {
  const formats = Object.values(FORMATS);

  it("mirrors capture_service.rs's table of native sizes", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/capture_service.rs", import.meta.url)),
      "utf8",
    );
    const table = /CAPTURE_FORMATS: &\[\(&str, u32, u32\)\] = &\[([^;]*)\];/.exec(source);
    if (!table) throw new Error("CAPTURE_FORMATS not found in capture_service.rs");
    const rust = [...table[1].matchAll(/\("([^"]+)", (\d+), (\d+)\)/g)].map((m) => ({
      name: m[1],
      width: Number(m[2]),
      height: Number(m[3]),
    }));
    expect(rust).toEqual(formats);
  });

  it.each(formats)("sizes $name: native alone, 1280 long edge for sheets, never upscaled", (f) => {
    expect(captureFormat(f)).toBe(f);
    expect(captureFormat(f, { frames: 1 })).toBe(f);
    const sheet = captureFormat(f, { sheet: true });
    const multi = captureFormat(f, { frames: 3 });
    expect(multi).toEqual(sheet);
    expect(Math.max(sheet.width, sheet.height)).toBe(1280);
    expect(sheet.name).toBe(f.name);
    for (const size of [
      sheet,
      captureFormat(f, { scale: 0.5 }),
      captureFormat(f, { scale: 0.01 }),
      captureFormat(f, { width: 1 }),
      captureFormat(f, { width: 641 }),
    ]) {
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(64);
      expect(size.width).toBeLessThanOrEqual(f.width);
      expect(size.height).toBeLessThanOrEqual(f.height);
      expect(Math.abs(size.width / size.height - f.width / f.height)).toBeLessThan(0.08);
    }
    expect(captureFormat(f, { scale: 1 })).toBe(f);
    expect(captureFormat(f, { width: f.width + 10 })).toBe(f);
    expect(captureFormat(f, { sheet: true, probe: true })).toBe(f);
    // The thumb rule this replaced, exactly.
    expect(captureFormat(f, { width: 640 })).toEqual({
      name: f.name,
      width: 640,
      height: Math.round((640 * f.height) / f.width / 2) * 2,
    });
  });

  it("matches the Rust mirror on the shared cases", () => {
    expect(captureFormat(FORMATS["16:9"], { width: 641 })).toMatchObject({
      width: 642,
      height: 362,
    });
    expect(captureFormat(FORMATS["16:9"], { width: 10 })).toMatchObject({ width: 114, height: 64 });
    expect(captureFormat(FORMATS.phone, { sheet: true })).toMatchObject({
      width: 588,
      height: 1280,
    });
    expect(captureFormat(FORMATS["4:5"], { frames: 2 })).toMatchObject({
      width: 1024,
      height: 1280,
    });
    expect(captureFormat(FORMATS["phone-landscape"], { width: 64 })).toMatchObject({
      width: 140,
      height: 64,
    });
  });

  it("validates a request's size and counts its units", () => {
    const k4 = FORMATS["16:9"];
    expect(requestCaptureFormat(request({ frames: [{}, {}], probe: [[1, 1]] }), k4)).toBe(k4);
    expect(requestCaptureFormat(request({ frames: [{}, {}], scale: 0.25 }), k4)).toMatchObject({
      width: 960,
      height: 540,
    });
    expect(() => requestCaptureFormat(request({ scale: 0 }), k4)).toThrow(
      "scale must be in (0, 1]",
    );
    expect(() => requestCaptureFormat(request({ width: -4 }), k4)).toThrow("whole number");
    expect(unitsFor(1, k4)).toBe(9);
    expect(unitsFor(1, { width: 1280, height: 720 })).toBe(1);
    expect(unitsFor(48, captureFormat(k4, { sheet: true }))).toBe(48);
    expect(unitsFor(1, captureFormat(FORMATS["4:5"], { sheet: true }))).toBe(2);
    expect(unitsFor(16, k4)).toBe(144);
  });
});

describe("probes", () => {
  const size = { width: 4, height: 2 };

  it("takes pairs, a flat list or a string, in bounds of the returned image", () => {
    expect(parseProbes(undefined, size)).toEqual([]);
    expect(parseProbes([[3, 1]], size)).toEqual([{ x: 3, y: 1 }]);
    expect(parseProbes([0, 0, 3, 1], size)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 1 },
    ]);
    expect(parseProbes("1, 1", size)).toEqual([{ x: 1, y: 1 }]);
    expect(() => parseProbes([[4, 0]], size)).toThrow("outside the 4x2 capture");
    expect(() => parseProbes([[0, -1]], size)).toThrow("outside");
    expect(() => parseProbes([[0.5, 1]], size)).toThrow("whole pixels");
    expect(() => parseProbes([1, 2, 3], size)).toThrow("x,y pairs");
    expect(() => parseProbes("a,b", size)).toThrow("whole pixels");
    const many = Array.from({ length: MAX_PROBES + 1 }, () => [0, 0]);
    expect(() => parseProbes(many, size)).toThrow(`at most ${MAX_PROBES}`);
    expect(parseProbes(many.slice(1), size)).toHaveLength(MAX_PROBES);
  });

  it("flips GL's bottom-up rows to a top-left origin", () => {
    const rgba = new Uint8Array(4 * 2 * 4);
    rgba.set([1, 2, 3, 255], 0);
    rgba.set([255, 128, 0, 200], (1 * 4 + 2) * 4);
    expect(
      samplePixels(rgba, 4, 2, [
        { x: 0, y: 1 },
        { x: 2, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 1, rgba: [1, 2, 3, 255], hex: "#010203" },
      { x: 2, y: 0, rgba: [255, 128, 0, 200], hex: "#ff8000" },
    ]);
  });
});

const request = (fields: Partial<BridgeRequest>): BridgeRequest => ({
  version: 2,
  id: "0001-1-abc",
  requestedAtMs: 1,
  ...fields,
});

const slots = [
  { index: 0, id: "hero", startMs: 0, endMs: 4000, durationMs: 4000 },
  { index: 1, id: "stats", startMs: 4000, endMs: 10000, durationMs: 6000 },
];
const sceneFiles = ["scenes/01-hero.tsx", "scenes/02-stats.tsx"];

/** A `pub const NAME: &[&str] = &[...]` list from bridge.rs, so the TS mirror can't drift from what Rust serves. */
function rustKinds(name: string): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/bridge.rs", import.meta.url)),
    "utf8",
  );
  const list = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source);
  if (!list) throw new Error(`${name} not found in bridge.rs`);
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("bridge kinds", () => {
  it("mirror bridge.rs exactly", () => {
    expect([...BRIDGE_KINDS]).toEqual(rustKinds("BRIDGE_KINDS"));
    expect([...NATIVE_BRIDGE_KINDS]).toEqual(rustKinds("NATIVE_KINDS"));
  });

  it("knows which kinds the native loop serves", () => {
    expect(isNativeBridgeKind("mediaChanged")).toBe(true);
    expect(isNativeBridgeKind("openEdit")).toBe(true);
    expect(isNativeBridgeKind("capture")).toBe(false);
    expect(isNativeBridgeKind(null)).toBe(false);
  });
});

describe("request shaping", () => {
  it("answers v1 captures as v1 and everything else as v2", () => {
    expect(responseVersion({ version: 1, kind: null })).toBe(1);
    expect(responseVersion({ version: 1, kind: "capture" })).toBe(2);
    expect(responseVersion({ version: 2 })).toBe(2);
  });

  it("takes a per-request aspect over the editor's and refuses unknown ones", () => {
    expect(requestFormat("phone", "16:9")).toBe(FORMATS.phone);
    expect(requestFormat(null, "9:16")).toBe(FORMATS["9:16"]);
    expect(requestFormat(undefined, null)).toBe(FORMATS["16:9"]);
    expect(() => requestFormat("21:9", "16:9")).toThrow(/unknown aspect "21:9".*phone-landscape/);
  });

  it("captures the frames list, else the top-level scene and time", () => {
    expect(requestFrames(request({ scene: "02-stats", at: 1.5 }))).toEqual([
      { scene: "02-stats", at: 1.5 },
    ]);
    expect(requestFrames(request({}))).toEqual([{ scene: null, at: null }]);
    expect(
      requestFrames(
        request({ scene: "ignored", frames: [{ scene: "1", at: 2 }, { scene: null }, {}] }),
      ),
    ).toEqual([
      { scene: "1", at: 2 },
      { scene: null, at: null },
      { scene: null, at: null },
    ]);
    const many = Array.from({ length: MAX_CAPTURE_FRAMES + 1 }, () => ({ scene: "0" }));
    expect(() => requestFrames(request({ frames: many }))).toThrow(/at most 48 frames/);
  });

  it("names the scene a frame landed in and the time into it", () => {
    const project = { slots, sceneFiles };
    expect(frameScene(project, "1", 5500)).toEqual({ index: 1, scene: "02-stats", at: 1.5 });
    expect(frameScene(project, "01-hero", 2000)).toEqual({ index: 0, scene: "01-hero", at: 2 });
    expect(frameScene(project, null, 9000.4)).toEqual({ index: 1, scene: "02-stats", at: 5 });
  });
});

describe("collectAssetRefs", () => {
  it("finds project-relative asset paths anywhere in a sidecar, once each", () => {
    const doc = {
      version: 1,
      media: { src: "assets/Screen Recording.mov", poster: "./assets/poster.png" },
      layers: [{ image: "assets/poster.png" }, { image: "https://example.com/x.png" }],
      text: { title: "Drop files in assets/\nthen save", folder: "assets/" },
      frame: { icon: "assets/icons/logo.svg" },
    };
    expect(collectAssetRefs(doc)).toEqual([
      "assets/Screen Recording.mov",
      "assets/poster.png",
      "assets/icons/logo.svg",
    ]);
    expect(collectAssetRefs(undefined)).toEqual([]);
  });
});

describe("buildCheckReport", () => {
  const project = {
    sceneFiles,
    slots,
    sceneDocs: [
      { version: 1, textStyle: { titleFont: "Menlo@400", bodyFont: "Inter" } },
      { version: 1, media: { src: "assets/clip.MOV" } },
    ] as unknown as (SceneDoc | undefined)[],
    compareBDocs: [undefined, undefined],
    healedSceneIds: ["scenes/02-stats.tsx"],
    sceneErrors: [
      { index: 0, file: "scenes/01-hero.tsx", phase: "compile" as const, message: "line 4: x" },
    ],
    fontIssues: [
      { ref: "Menlo@400", message: "unknown cmap table format 6", fallback: "Inter@400" },
    ],
  };

  it("reports scene, font and asset problems against a real load", () => {
    const report = buildCheckReport({
      project,
      renderErrors: [
        { index: 1, file: "scenes/02-stats.tsx", phase: "render", message: "chart threw" },
      ],
      assets: [{ path: "assets/clip.MOV", ok: false, error: "no such file" }],
    });
    expect(report.ok).toBe(false);
    expect(report.scenes).toEqual([
      {
        index: 0,
        file: "scenes/01-hero.tsx",
        id: "hero",
        ok: false,
        phase: "compile",
        error: "line 4: x",
        warnings: [],
      },
      {
        index: 1,
        file: "scenes/02-stats.tsx",
        id: "stats",
        ok: false,
        phase: "render",
        error: "chart threw",
        warnings: ["assets/clip.MOV: no such file"],
      },
    ]);
    expect(report.fonts).toEqual([
      {
        ref: "Menlo@400",
        ok: false,
        error: "unknown cmap table format 6",
        fallback: "Inter@400",
      },
      { ref: "Inter@400", ok: true },
    ]);
    expect(report.assets).toEqual([{ path: "assets/clip.MOV", ok: false, error: "no such file" }]);
    expect(report.warnings).toEqual([
      "scenes/02-stats.tsx shared its scene id with another scene, so it was given a new one",
    ]);
  });

  it("passes a clean project, treating absent diagnostics as empty", () => {
    const report = buildCheckReport({
      project: { ...project, sceneErrors: undefined, fontIssues: undefined, healedSceneIds: [] },
      assets: [{ path: "assets/clip.MOV", ok: true }],
    });
    expect(report.ok).toBe(true);
    expect(report.scenes.every((scene) => scene.ok && scene.warnings.length === 0)).toBe(true);
    expect(report.fonts.map((font) => font.ref)).toEqual(["Menlo@400", "Inter@400"]);
  });

  it("carries the load's ignored settings as warnings without failing the check", () => {
    const report = buildCheckReport({
      project: {
        ...project,
        sceneErrors: undefined,
        fontIssues: undefined,
        loadWarnings: [`themes/brand/theme.json: "card" is invalid, dropped`],
      },
      assets: [{ path: "assets/clip.MOV", ok: true }],
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      "scenes/02-stats.tsx shared its scene id with another scene, so it was given a new one",
      `themes/brand/theme.json: "card" is invalid, dropped`,
    ]);
  });
});

describe("resolvePresetRef", () => {
  const entries = [
    { id: "title", slug: "title", projectId: "preset:title", name: "Title", source: "bundled" },
    { id: "chart", slug: "chart", projectId: "preset:chart", name: "Chart", source: "bundled" },
    {
      id: "ws:title",
      slug: "title",
      projectId: "ws-preset:title",
      name: "My title",
      source: "user",
    },
    { id: "ws:promo", slug: "promo", projectId: "ws-preset:promo", name: "Promo", source: "user" },
  ];

  it("resolves the gallery's id forms, bundled first for a bare slug", () => {
    expect(resolvePresetRef("title", entries)?.projectId).toBe("preset:title");
    expect(resolvePresetRef("preset:chart", entries)?.projectId).toBe("preset:chart");
    expect(resolvePresetRef("ws-preset:title", entries)?.projectId).toBe("ws-preset:title");
    expect(resolvePresetRef("ws:title", entries)?.projectId).toBe("ws-preset:title");
    expect(resolvePresetRef("promo", entries)?.projectId).toBe("ws-preset:promo");
    expect(resolvePresetRef(" my TITLE ", entries)?.projectId).toBe("ws-preset:title");
    expect(resolvePresetRef("preset:promo", entries)).toBeUndefined();
    expect(resolvePresetRef("nothing", entries)).toBeUndefined();
  });
});

describe("trust", () => {
  it("names the project a declined gate refused, and only for that error", () => {
    expect(trustDeniedSlug(new TrustDeniedError("product-tour"))).toBe("product-tour");
    expect(trustDeniedSlug(new Error('Project "x" was not opened.'))).toBeNull();
    expect(trustSentence("demo")).toMatch(/^"demo" changed since you last allowed it/);
    expect(trustSentence("demo")).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("contact sheet layout", () => {
  it("lays landscape frames four across and portrait six across", () => {
    const wide = contactSheetLayout(6, 3840, 2160);
    expect(wide).toMatchObject({ columns: 4, rows: 2, tileWidth: 480, tileHeight: 270 });
    expect(wide.width).toBe(4 * 480 + 5 * 8);
    expect(wide.height).toBe(2 * (270 + 26) + 3 * 8);
    expect(tileOrigin(wide, 5)).toEqual({ x: 8 + 488, y: 8 + 270 + 26 + 8 });
    const tall = contactSheetLayout(2, 2160, 3840);
    expect(tall).toMatchObject({ columns: 2, rows: 1, tileWidth: 270, tileHeight: 480 });
    expect(contactSheetLayout(1, 1206, 2622)).toMatchObject({ columns: 1, tileHeight: 587 });
  });
});

describe("lastLoadReport", () => {
  it("reports a degraded load as ok with its diagnostics", () => {
    const loaded = {
      sceneErrors: [
        { index: 2, file: "scenes/03-x.tsx", phase: "evaluate" as const, message: "y" },
      ],
      healedSceneIds: [],
    } as Pick<LoadedProject, "sceneErrors" | "fontIssues" | "healedSceneIds">;
    expect(lastLoadReport("ws:demo", { loaded }, 5)).toEqual({
      project: "ws:demo",
      ok: true,
      atMs: 5,
      error: null,
      sceneErrors: loaded.sceneErrors,
      fontIssues: [],
      warnings: [],
    });
  });

  it("reports a failed load with its message", () => {
    expect(lastLoadReport("ws:demo", { error: new TrustDeniedError("demo") }, 6)).toMatchObject({
      ok: false,
      error: 'Project "demo" was not opened.',
      sceneErrors: [],
    });
    expect(lastLoadReport("ws:demo", { error: "boom" }, 6).error).toBe("boom");
  });
});
