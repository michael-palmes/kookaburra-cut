import { describe, expect, it } from "vitest";
import { SPEED_OPTIONS, speedChoices } from "./speedOptions";

describe("speedChoices", () => {
  it("lists the menu when the speed is on it", () => {
    expect(speedChoices(1.5).map((c) => c.label)).toEqual(SPEED_OPTIONS.map((s) => `${s}×`));
    expect(speedChoices(undefined)).toHaveLength(SPEED_OPTIONS.length);
  });

  it("adds an off-menu speed in order, its value exact so the select shows it", () => {
    const choices = speedChoices(1.35);
    expect(choices.map((c) => c.label)).toEqual([
      "0.25×",
      "0.5×",
      "0.75×",
      "1×",
      "1.25×",
      "1.35×",
      "1.5×",
      "2×",
      "4×",
      "6×",
    ]);
    expect(choices.find((c) => c.label === "1.35×")?.value).toBe(String(1.35));
    const fine = speedChoices(1 / 3).find((c) => c.label === "0.333×");
    expect(fine?.value).toBe(String(1 / 3));
    expect(speedChoices(8).at(-1)).toEqual({ value: "8", label: "8×" });
  });
});
