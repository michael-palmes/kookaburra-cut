import { describe, expect, it } from "vitest";
import { parseEmphasisMarkup, prepareDisplayText } from "./displayText";
import { prepareEmojiText } from "./emojiText";

const emphasised = (raw: string) => {
  const { text, ranges } = parseEmphasisMarkup(raw);
  return { text, words: ranges.map(([s, e]) => text.slice(s, e)) };
};

describe("parseEmphasisMarkup", () => {
  it("strips flanking pairs and records the ranges", () => {
    expect(parseEmphasisMarkup("Ship *faster* today")).toEqual({
      text: "Ship faster today",
      ranges: [[5, 11]],
    });
    expect(emphasised("*One* and *two words*")).toEqual({
      text: "One and two words",
      words: ["One", "two words"],
    });
  });

  it("keeps a lone asterisk and arithmetic literal", () => {
    for (const raw of [
      "5 * 3 = 15",
      "a lone * here",
      "*",
      "**",
      "* * *",
      "Terms apply*",
      "*not closed",
    ]) {
      expect(parseEmphasisMarkup(raw)).toEqual({ text: raw, ranges: [] });
    }
  });

  it("follows markdown's flanking rules", () => {
    expect(emphasised("Save 20%* on *all* plans")).toEqual({
      text: "Save 20%* on all plans",
      words: ["all"],
    });
    expect(emphasised('*"quoted"*').words).toEqual(['"quoted"']);
    expect(emphasised("foo*bar")).toEqual({ text: "foo*bar", words: [] });
    expect(emphasised("2*3*4")).toEqual({ text: "234", words: ["3"] });
    expect(emphasised("* not* emphasis *")).toEqual({ text: "* not* emphasis *", words: [] });
  });

  it("treats double and triple runs as one emphasis and unions nesting", () => {
    expect(emphasised("**bold** move")).toEqual({ text: "bold move", words: ["bold"] });
    expect(emphasised("***both***")).toEqual({ text: "both", words: ["both"] });
    expect(emphasised("*a *b* c*")).toEqual({ text: "a b c", words: ["a b c"] });
    expect(emphasised("**foo*")).toEqual({ text: "*foo", words: ["foo"] });
  });

  it("crosses a line break but never a blank line", () => {
    expect(emphasised("*one\ntwo*").words).toEqual(["one\ntwo"]);
    expect(parseEmphasisMarkup("*one\n\ntwo*").ranges).toEqual([]);
    expect(emphasised("*one*\n\n*two*").words).toEqual(["one", "two"]);
  });

  it("never treats the keycap emoji as markup", () => {
    const keycap = "*️⃣";
    expect(emphasised(`${keycap} press *here*`)).toEqual({
      text: `${keycap} press here`,
      words: ["here"],
    });
  });
});

describe("prepareDisplayText", () => {
  it("returns prepareEmojiText's exact output for copy without markup", () => {
    for (const raw of ["Plain words", "Hi 👋 there", "5 * 3", "", "Line\nbreak"]) {
      const prepared = prepareDisplayText(raw);
      expect({ text: prepared.text, clusters: prepared.clusters }).toEqual(prepareEmojiText(raw));
      expect(prepared.emphasis).toEqual([]);
    }
  });

  it("carries ranges through the emoji substitution", () => {
    const prepared = prepareDisplayText("Hi 👋 *there*");
    expect(prepared.text).toBe(`Hi ${prepared.text[3]} there`);
    expect(prepared.emphasis).toEqual([[5, 10]]);
    const wave = prepareDisplayText("*👋 wave* now");
    expect(wave.text.length).toBe("x wave now".length);
    expect(wave.emphasis).toEqual([[0, 6]]);
    expect(wave.clusters[0].codeUnitIndex).toBe(0);
  });
});
