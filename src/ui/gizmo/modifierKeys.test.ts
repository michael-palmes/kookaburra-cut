import { describe, expect, it } from "vitest";
import { modifiersFrom } from "./modifierKeys";

describe("modifiersFrom", () => {
  it("projects exactly the four flags and drops everything else", () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      clientX: 12,
      key: "a",
    };
    expect(modifiersFrom(event)).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    });
  });
});
