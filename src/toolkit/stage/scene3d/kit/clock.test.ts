import { describe, expect, it } from "vitest";
import { lookSeconds, loopSeconds } from "./clock";

describe("look clock", () => {
  it("reads absolute project milliseconds times speed", () => {
    expect(lookSeconds(0, 1)).toBe(0);
    expect(lookSeconds(12_500, 1)).toBe(12.5);
    expect(lookSeconds(12_500, 0.4)).toBeCloseTo(5, 12);
    expect(lookSeconds(12_500, 0)).toBe(0);
  });

  it("wraps into one period, negative-safe", () => {
    expect(loopSeconds(95, 90)).toBe(5);
    expect(loopSeconds(90, 90)).toBe(0);
    expect(loopSeconds(-5, 90)).toBe(85);
    expect(loopSeconds(12, 0)).toBe(12);
  });
});
