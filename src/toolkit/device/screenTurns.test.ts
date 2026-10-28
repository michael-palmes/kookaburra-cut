import { describe, expect, it } from "vitest";
import { autoScreenTurns, screenTurns } from "./screenTurns";

const DEG = Math.PI / 180;

describe("autoScreenTurns", () => {
  it("leaves an upright device's media alone, however it is yawed or tilted", () => {
    for (const rotation of [
      [0, 0, 0],
      [0, 90 * DEG, 0],
      [4 * DEG, -20 * DEG, 0],
      [4 * DEG, 160 * DEG, 0],
      [-30 * DEG, 0, 0],
    ] as const) {
      expect(autoScreenTurns([...rotation])).toBe(0);
    }
  });

  it("turns the media against the device's roll, to the nearest quarter", () => {
    expect(autoScreenTurns([0, 0, 90 * DEG])).toBe(1);
    expect(autoScreenTurns([4 * DEG, -16 * DEG, 90 * DEG])).toBe(1);
    expect(autoScreenTurns([0, 0, -90 * DEG])).toBe(3);
    expect(autoScreenTurns([0, 0, 180 * DEG])).toBe(2);
    expect(autoScreenTurns([0, 0, 30 * DEG])).toBe(0);
    expect(autoScreenTurns([0, 0, 60 * DEG])).toBe(1);
  });

  it("reads a phone laid flat top-away, and its spin on the table", () => {
    expect(autoScreenTurns([-90 * DEG, 0, 0])).toBe(0);
    expect(autoScreenTurns([-90 * DEG, 0, 90 * DEG])).toBe(1);
  });

  it("stands Tent's outside display upright", () => {
    expect(autoScreenTurns([38 * DEG, -20 * DEG, -75 * DEG])).toBe(3);
  });
});

describe("screenTurns", () => {
  it("maps the authored degrees, and reads anything else as unturned", () => {
    expect(screenTurns(undefined, [0, 0, 90 * DEG])).toBe(0);
    expect(screenTurns(90, [0, 0, 0])).toBe(1);
    expect(screenTurns(180, [0, 0, 0])).toBe(2);
    expect(screenTurns(270, [0, 0, 0])).toBe(3);
    expect(screenTurns(45, [0, 0, 0])).toBe(0);
    expect(screenTurns("auto", [0, 0, -90 * DEG])).toBe(3);
  });
});
