import { describe, expect, it } from "vitest";
import { BUNDLED_EXPORT_PRESETS, findBundledPreset } from "../export/presetRegistry";
import {
  audioKbpsOf,
  customSeed,
  draftFromDoc,
  draftToDoc,
  estimateSizeMB,
  fitToCap,
  groupPresets,
  highQualityEncode,
  openingPosterFrameEnabled,
  presetAspects,
  railPresets,
  resolveDraft,
  slugifyPresetName,
  specChips,
  withPosterFrame,
} from "./exportOptions";

/** A bundled preset the suite depends on; throw loudly rather than assert non-null. */
function bundled(id: string) {
  const preset = findBundledPreset(id);
  if (!preset) throw new Error(`bundled preset missing: ${id}`);
  return preset;
}

/** Narrow a nullable the test has already proven present. */
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("expected a value");
  return value;
}

const reels = () => bundled("meta-reels");

describe("size estimate + Fit to cap (the decision-18 goldens)", () => {
  it("bitrate mode: (video + audio) kbps × duration × 1.05 / 8", () => {
    // 12000 + 128 kbps over 30 s: 12128 × 30 × 1.05 / 8 / 1000 = 47.754 MB.
    expect(estimateSizeMB(reels(), 30_000, 128)).toBeCloseTo(47.754, 3);
    // No soundtrack → no audio bits.
    expect(estimateSizeMB(reels(), 30_000, 0)).toBeCloseTo(47.25, 3);
  });

  it("CRF and ProRes skip the check (size varies with content)", () => {
    expect(estimateSizeMB(bundled("share-h264"), 30_000, 128)).toBeNull();
    expect(estimateSizeMB(bundled("kookaburra-master"), 30_000, 128)).toBeNull();
  });

  it("fitToCap solves the target from the cap and scales max/bufsize along", () => {
    const fitted = fitToCap(
      { targetKbps: 8000, maxKbps: 10000, bufsizeKbps: 16000 },
      200,
      120_000,
      128,
    );
    // 200 MB × 8000 / (120 s × 1.05) − 128 = 12570 kbps (floored).
    expect(fitted).toEqual({ targetKbps: 12570, maxKbps: 15713, bufsizeKbps: 25140 });
  });

  it("a fitted rate re-estimates at or under the cap", () => {
    const doc = structuredClone(bundled("linkedin-ads"));
    // Force an over-cap duration, fit, and confirm the estimate lands under 200 MB.
    const over = present(estimateSizeMB(doc, 240_000, 128));
    expect(over).toBeGreaterThan(200);
    doc.video.rate = fitToCap(
      doc.video.rate as { targetKbps: number; maxKbps: number; bufsizeKbps: number },
      200,
      240_000,
      128,
    );
    expect(present(estimateSizeMB(doc, 240_000, 128))).toBeLessThanOrEqual(200);
  });

  it("PCM audio estimates at 48 kHz × bits × stereo", () => {
    expect(audioKbpsOf(bundled("kookaburra-master"))).toBe(2304);
    expect(audioKbpsOf(reels())).toBe(128);
  });
});

describe("row chips", () => {
  it("bundled shapes render the codec · res@fps · rate · cap chips", () => {
    expect(specChips(reels())).toEqual(["H.264", "1080p @ 30fps", "12 Mbps", "≤ 250 MB"]);
    expect(specChips(bundled("ctv"))).toEqual(["H.264", "1080p @ 30fps", "8 Mbps two-pass"]);
    expect(specChips(bundled("kookaburra-master"))).toEqual(["ProRes 422 HQ", "Native @ 60fps"]);
  });

  it("VideoToolbox lanes carry the fast-draft label", () => {
    const doc = structuredClone(reels());
    doc.video.codec = "h264_videotoolbox";
    expect(specChips(doc)).toContain("fast draft — excluded from Verify");
  });

  it("hardware ProRes is fast-draft labelled with no rate chip", () => {
    const doc = structuredClone(bundled("kookaburra-master"));
    doc.video.codec = "prores_videotoolbox";
    expect(specChips(doc)).toEqual([
      "ProRes 422 HQ",
      "Native @ 60fps",
      "fast draft — excluded from Verify",
    ]);
  });
});

describe("grouping + filtering", () => {
  it("groups the bundled lineup by platform in lineup order", () => {
    const groups = groupPresets(BUNDLED_EXPORT_PRESETS, [], "", null);
    expect(groups.map((g) => g.platform)).toEqual([
      "General",
      "Studio",
      "Meta",
      "TikTok",
      "YouTube",
      "LinkedIn",
      "X",
      "Reddit",
      "Telegram",
      "CTV",
    ]);
    expect(present(groups.find((g) => g.platform === "Meta")).rows.map((r) => r.id)).toEqual([
      "meta-reels",
      "meta-feed",
    ]);
  });

  it("the rail lineup slots High quality (the frozen path) at the head of Studio", () => {
    const groups = groupPresets(railPresets(BUNDLED_EXPORT_PRESETS), [], "", null);
    expect(present(groups.find((g) => g.platform === "Studio")).rows.map((r) => r.id)).toEqual([
      "kookaburra-standard",
      "kookaburra-master",
    ]);
    expect(groups.map((g) => g.platform).slice(0, 2)).toEqual(["General", "Studio"]);
  });

  it("the aspect chip filters on allowedAspects; user rows group under Your presets", () => {
    const user = [
      { id: "ws:mine", doc: { ...reels(), id: "ws:mine", name: "Mine" }, isUser: true },
    ];
    const groups = groupPresets(BUNDLED_EXPORT_PRESETS, user, "", "9:16");
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids).toContain("meta-reels");
    expect(ids).not.toContain("ctv"); // 16:9-only
    expect(present(groups.at(-1)).platform).toBe("Your presets");
  });

  it("search matches name/description/platform", () => {
    const groups = groupPresets(BUNDLED_EXPORT_PRESETS, [], "linkedin", null);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("absent allowedAspects means every aspect", () => {
    const doc = structuredClone(reels());
    doc.allowedAspects = undefined;
    expect(presetAspects(doc)).toEqual(["16:9", "9:16", "1:1", "4:5", "5:4", "3:2", "2:3"]);
  });
});

describe("the Custom draft", () => {
  it("seeds from the frozen legacy method (decision 24)", () => {
    const seed = customSeed();
    expect(seed.codec).toBe("libx264");
    expect(seed.rateMode).toBe("crf");
    expect(seed.crf).toBe(18);
    expect(seed.shortEdge).toBeNull();
    expect(seed.fps).toBe(60);
    expect(seed.faststart).toBe(false);
    expect(seed.colourTags).toBe(false);
    expect(seed.audioMode).toBe("aac");
    expect(seed.aacKbps).toBe(192);
    expect(seed.loudnessTarget).toBeNull();
  });

  it("doc → draft → doc round-trips the video and audio blocks", () => {
    for (const id of ["meta-reels", "ctv", "share-h265", "kookaburra-master"]) {
      const doc = bundled(id);
      const back = draftToDoc(
        draftFromDoc(doc),
        doc.id,
        doc.name,
        doc.description,
        doc.platform,
        doc.favouredAspect,
      );
      expect(back.video).toEqual(doc.video);
      expect(back.audio).toEqual(doc.audio);
    }
  });

  it("surfaces the resolve-time rejections as readable inline errors", () => {
    const vtCrf = { ...customSeed(), codec: "h264_videotoolbox" as const };
    expect(resolveDraft(vtCrf).error).toMatch(/bitrate-only/);
    const pcmMp4 = { ...customSeed(), audioMode: "pcm" as const };
    expect(resolveDraft(pcmMp4).error).toMatch(/\.mov/);
    expect(resolveDraft(customSeed()).spec?.codec).toBe("libx264");
  });

  it("keeps the poster frame runtime-only and out of saved presets", () => {
    const draft = customSeed();
    const doc = draftToDoc(draft, "ws:links", "Links", "");
    expect(doc.video).not.toHaveProperty("posterFrame");
    const spec = present(resolveDraft(draft).spec);
    expect(withPosterFrame(spec, false)).toBe(spec);
    expect(withPosterFrame(spec, true).posterFrame).toBe(true);
  });

  it("defaults the app-wide opening poster frame on and honours its opt-out", () => {
    expect(openingPosterFrameEnabled()).toBe(true);
    expect(openingPosterFrameEnabled(false)).toBe(true);
    expect(openingPosterFrameEnabled(true)).toBe(false);
  });

  it("keeps High quality legacy when off and resolves its spec only when on", () => {
    expect(highQualityEncode(false)).toBeUndefined();
    expect(highQualityEncode(true)).toMatchObject({
      codec: "libx264",
      fps: 60,
      rate: { crf: 18 },
      posterFrame: true,
    });
  });

  it("slugifies preset names to workspace slugs", () => {
    expect(slugifyPresetName("My LinkedIn (tight) Preset!")).toBe("my-linkedin-tight-preset");
    expect(slugifyPresetName("  Ünïcode  ")).toBe("n-code");
  });
});
