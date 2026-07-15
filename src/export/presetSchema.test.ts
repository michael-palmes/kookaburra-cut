import { describe, expect, it } from "vitest";
import { BUNDLED_EXPORT_PRESETS, findBundledPreset } from "./presetRegistry";
import { parseExportPreset, resolvePresetToEncodeSpec } from "./presetSchema";

/** A bundled preset the suite depends on; throws loudly rather than asserting non-null. */
function bundled(id: string) {
  const preset = findBundledPreset(id);
  if (!preset) throw new Error(`bundled preset missing: ${id}`);
  return preset;
}

/** The 13-preset 2026 marketing set (decision 21); the id list IS the contract. */
const LINEUP = [
  "kookaburra-master",
  "meta-reels",
  "meta-feed",
  "tiktok",
  "youtube",
  "youtube-shorts",
  "linkedin-ads",
  "linkedin-organic",
  "x",
  "reddit",
  "telegram",
  "ctv",
  "web",
];

describe("bundled export presets (the structure pin)", () => {
  it("the lineup is exactly the 13-preset marketing set, every doc resolving", () => {
    expect(BUNDLED_EXPORT_PRESETS.map((p) => p.id)).toEqual(LINEUP);
    for (const doc of BUNDLED_EXPORT_PRESETS) {
      const spec = resolvePresetToEncodeSpec(doc);
      expect(spec.fps === 30 || spec.fps === 60).toBe(true);
      // Every non-master lane converts + tags bt709 at the same filter.
      if (doc.id !== "kookaburra-master") expect(spec.codec).toBe("libx264");
      expect(spec.colourTags).toBe(true);
    }
  });

  it("ctv and youtube are the two-pass presets; meta-reels is single-pass", () => {
    for (const id of ["ctv", "youtube"]) {
      const spec = resolvePresetToEncodeSpec(bundled(id));
      expect("twoPass" in spec.rate && spec.rate.twoPass).toBe(true);
    }
    const reels = resolvePresetToEncodeSpec(bundled("meta-reels"));
    expect("twoPass" in reels.rate && reels.rate.twoPass).toBeFalsy();
  });

  it("the master is the ProRes/PCM-24 archive lane; the capped presets carry caps", () => {
    const master = bundled("kookaburra-master");
    const spec = resolvePresetToEncodeSpec(master);
    expect(spec.codec).toBe("prores_ks");
    expect(master.audio.codec).toEqual({ pcmBits: 24 });
    expect(master.audio.loudnessTarget).toBeUndefined();
    const caps = Object.fromEntries(
      BUNDLED_EXPORT_PRESETS.filter((p) => p.maxFileSizeMB).map((p) => [p.id, p.maxFileSizeMB]),
    );
    expect(caps).toEqual({ "meta-reels": 250, tiktok: 250, "linkedin-ads": 200, x: 512 });
  });

  it("every favoured aspect is allowed by its own preset", () => {
    for (const doc of BUNDLED_EXPORT_PRESETS) {
      if (doc.allowedAspects) expect(doc.allowedAspects).toContain(doc.favouredAspect);
    }
  });

  it("rejects the impossible combinations at resolve time", () => {
    const doc = structuredClone(bundled("meta-reels"));
    doc.video.codec = "h264_videotoolbox";
    doc.video.rate = { crf: 20 };
    expect(() => resolvePresetToEncodeSpec(doc)).toThrow(/bitrate-only/);
    doc.video.rate = { targetKbps: 1, maxKbps: 1, bufsizeKbps: 1, twoPass: true };
    expect(() => resolvePresetToEncodeSpec(doc)).toThrow(/cannot two-pass/);
    doc.video.codec = "libx264";
    doc.audio = { codec: { pcmBits: 16 } };
    expect(() => resolvePresetToEncodeSpec(doc)).toThrow(/\.mov/);
  });

  it("degrades bad documents to undefined, never throws", () => {
    expect(parseExportPreset(null, "t")).toBeUndefined();
    expect(parseExportPreset({ version: 99 }, "t")).toBeUndefined();
    expect(parseExportPreset({ version: 1, id: "x" }, "t")).toBeUndefined();
  });
});
