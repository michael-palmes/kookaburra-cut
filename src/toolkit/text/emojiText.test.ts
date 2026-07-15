import { describe, expect, it } from "vitest";
import { EMOJI_PUA_START, SYMBOLS_CODEPOINTS } from "../../theme/symbolsCodepoints.generated";
import { emojiClusterKey, prepareEmojiText } from "./emojiText";

const PUA = (n: number) => String.fromCodePoint(EMOJI_PUA_START + n);

describe("prepareEmojiText", () => {
  it("returns plain text byte-identical with zero clusters", () => {
    const raw = "Ship it now";
    const prepared = prepareEmojiText(raw);
    expect(prepared.text).toBe(raw);
    expect(prepared.clusters).toEqual([]);
  });

  it("passes bare text-default symbols through untouched", () => {
    const raw = "Done ✓ next → star ★ warn ⚠ heart ❤";
    const prepared = prepareEmojiText(raw);
    expect(prepared.text).toBe(raw);
    expect(prepared.clusters).toEqual([]);
  });

  it("substitutes an astral emoji with one placeholder code unit", () => {
    const prepared = prepareEmojiText("Launch 🚀");
    expect(prepared.text).toBe(`Launch ${PUA(0)}`);
    expect(prepared.clusters).toEqual([{ codeUnitIndex: 7, cluster: "🚀", key: "1f680" }]);
  });

  it("keeps a ZWJ sequence as a single cluster", () => {
    const prepared = prepareEmojiText("👩‍👩‍👧");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters).toHaveLength(1);
    expect(prepared.clusters[0].key).toBe("1f469-200d-1f469-200d-1f467");
  });

  it("keeps a flag as a single cluster", () => {
    const prepared = prepareEmojiText("🇦🇺");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("1f1e6-1f1fa");
  });

  it("keeps a skin-tone modifier sequence as a single cluster", () => {
    const prepared = prepareEmojiText("👍🏽");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("1f44d-1f3fd");
  });

  it("substitutes a keycap sequence", () => {
    const prepared = prepareEmojiText("1️⃣");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("31-fe0f-20e3");
  });

  it("routes VS16 emoji presentation to the colour path", () => {
    const prepared = prepareEmojiText("❤️");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("2764-fe0f");
  });

  it("strips a variation selector from a non-emoji cluster", () => {
    expect(prepareEmojiText("✓️").text).toBe("✓");
    expect(prepareEmojiText("→️").text).toBe("→");
    expect(prepareEmojiText("✓︎").text).toBe("✓");
    expect(prepareEmojiText("✓️").clusters).toEqual([]);
  });

  it("routes a redundant VS16 on an emoji-default base to colour (the web-paste star)", () => {
    const prepared = prepareEmojiText("⭐️");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("2b50");
    // Bare and redundant-VS16 forms share the canonical key and cache entry.
    expect(prepareEmojiText("⭐").clusters[0].key).toBe("2b50");
  });

  it("routes a bare astral pictograph to colour (macOS renders it colour everywhere)", () => {
    const prepared = prepareEmojiText("🏘");
    expect(prepared.text).toBe(PUA(0));
    expect(prepared.clusters[0].key).toBe("1f3d8");
    expect(prepareEmojiText("🏘️").clusters[0].key).toBe("1f3d8-fe0f");
  });

  it("keeps BMP text-default symbols mono unless explicitly VS16-ed", () => {
    expect(prepareEmojiText("bare ♥ and ⚠ stay text").clusters).toEqual([]);
    expect(prepareEmojiText("♥️").clusters[0]?.key).toBe("2665-fe0f");
    expect(prepareEmojiText("☑️").clusters[0]?.key).toBe("2611-fe0f");
  });

  it("VS15 forces the text path even on emoji-capable bases", () => {
    const prepared = prepareEmojiText("☑︎");
    expect(prepared.text).toBe("☑");
    expect(prepared.clusters).toEqual([]);
  });

  it("reuses one placeholder for a repeated cluster but records every occurrence", () => {
    const prepared = prepareEmojiText("🚀🚀");
    expect(prepared.text).toBe(`${PUA(0)}${PUA(0)}`);
    expect(prepared.clusters).toHaveLength(2);
    expect(prepared.clusters[0].codeUnitIndex).toBe(0);
    expect(prepared.clusters[1].codeUnitIndex).toBe(1);
  });

  it("assigns sequential placeholders to distinct clusters", () => {
    const prepared = prepareEmojiText("🚀✨");
    expect(prepared.text).toBe(`${PUA(0)}${PUA(1)}`);
  });

  it("preserves paragraph structure around substitutions", () => {
    const prepared = prepareEmojiText("New 🚀\n\nShip ✓");
    expect(prepared.text).toBe(`New ${PUA(0)}\n\nShip ✓`);
    expect(prepared.clusters).toHaveLength(1);
  });

  it("is deterministic for repeated calls", () => {
    const raw = "Mixed 🚀 text → with 👩‍💻 emoji ✓";
    expect(prepareEmojiText(raw)).toEqual(prepareEmojiText(raw));
  });

  it("records code-unit indices that land on the placeholders in the output text", () => {
    const prepared = prepareEmojiText("a🚀b👩‍💻c");
    for (const cluster of prepared.clusters) {
      const cp = prepared.text.codePointAt(cluster.codeUnitIndex);
      expect(cp).toBeGreaterThanOrEqual(EMOJI_PUA_START);
    }
  });
});

describe("emojiClusterKey", () => {
  it("distinguishes adjacent-but-distinct sequences", () => {
    expect(emojiClusterKey("👍🏽")).not.toBe(emojiClusterKey("👍"));
    expect(emojiClusterKey("❤️")).not.toBe(emojiClusterKey("❤"));
  });

  it("is stable hex codepoints dash-joined", () => {
    expect(emojiClusterKey("🚀")).toBe("1f680");
  });
});

describe("symbols coverage contract", () => {
  it("covers the live-bug characters", () => {
    for (const ch of ["→", "✓", "★"]) {
      const cp = ch.codePointAt(0);
      expect(cp).toBeDefined();
      if (cp !== undefined) expect(SYMBOLS_CODEPOINTS.has(cp)).toBe(true);
    }
  });
});
