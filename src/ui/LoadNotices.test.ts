import { describe, expect, it } from "vitest";
import type { LoadedProject } from "../engine/project";
import { degradedLoadNotice } from "./LoadNotices";

const project = (fields: Partial<LoadedProject>): LoadedProject =>
  ({ id: "ws:demo", ...fields }) as LoadedProject;

describe("degradedLoadNotice", () => {
  it("titles a load whose only problems are ignored settings", () => {
    const notice = degradedLoadNotice(
      project({ loadWarnings: [`themes/brand/theme.json: "card" is invalid, dropped`] }),
    );
    expect(notice?.title).toBe("Some settings were ignored");
    expect(notice?.lines).toEqual([`themes/brand/theme.json: "card" is invalid, dropped`]);
    expect(notice?.hint).toMatch(/renders without them/);
  });

  it("keeps the problem title when a warning also blocks export", () => {
    const notice = degradedLoadNotice(
      project({
        loadWarnings: ["The colour LUT couldn't load, so the project renders without it: 404"],
        exportBlockers: ["the colour LUT couldn't load (404)"],
      }),
    );
    expect(notice?.title).toBe("This project loaded with a problem");
  });

  it("stays quiet for a clean load", () => {
    expect(degradedLoadNotice(project({ loadWarnings: [] }))).toBeNull();
  });
});
