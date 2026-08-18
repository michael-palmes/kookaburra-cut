import { describe, expect, it } from "vitest";
import { HEADER_EMOJIS } from "../SceneTextFields";
import { TEXT_ICON_EMOJIS } from "./textIconEmojiCatalogue";

describe("text icon emoji catalogue", () => {
  it("starts with the quick choices and provides a broad unique selection", () => {
    expect(TEXT_ICON_EMOJIS.slice(0, HEADER_EMOJIS.length)).toEqual(HEADER_EMOJIS);
    expect(TEXT_ICON_EMOJIS.length).toBeGreaterThanOrEqual(128);
    expect(new Set(TEXT_ICON_EMOJIS).size).toBe(TEXT_ICON_EMOJIS.length);
    expect(TEXT_ICON_EMOJIS.every((emoji) => emoji.trim().length > 0)).toBe(true);
  });
});
