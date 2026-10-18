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
  collectAssetRefs,
  frameScene,
  isNativeBridgeKind,
  MAX_CAPTURE_FRAMES,
  NATIVE_BRIDGE_KINDS,
  requestFormat,
  requestFrames,
  resolvePresetRef,
  responseVersion,
  trustDeniedSlug,
  trustSentence,
} from "./bridgeRequests";
import { contactSheetLayout, tileOrigin } from "./contactSheet";

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
