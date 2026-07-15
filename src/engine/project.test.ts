import { describe, expect, it } from "vitest";
import { assertProjectRelative } from "./project";

describe("assertProjectRelative", () => {
  it("passes a legitimate assets path through unchanged", () => {
    expect(assertProjectRelative("assets/x.mp4")).toBe("assets/x.mp4");
  });

  it("strips a leading ./", () => {
    expect(assertProjectRelative("./assets/x.mp4")).toBe("assets/x.mp4");
  });

  it("rejects an empty string", () => {
    expect(() => assertProjectRelative("")).toThrow();
  });

  it("rejects a relative traversal that climbs out of the project", () => {
    expect(() => assertProjectRelative("../../etc/passwd")).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => assertProjectRelative("/etc/passwd")).toThrow();
  });

  it("rejects a .. segment buried after a legitimate-looking prefix", () => {
    expect(() => assertProjectRelative("assets/../../secret")).toThrow();
  });
});
