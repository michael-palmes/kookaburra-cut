import { describe, expect, it } from "vitest";
import { nameCollision, nameCollisionWarning } from "./nameCollision";

const projects = ["launch-2026", "showcase-tour", "device-video-spike"];

describe("nameCollision", () => {
  it("reports the slug the name would save as", () => {
    expect(nameCollision("My Project", projects)).toEqual({ slug: "my-project", collides: false });
    expect(nameCollision("  Spaced  Out  ", projects)).toEqual({
      slug: "spaced-out",
      collides: false,
    });
  });

  it("catches an exact slug clash", () => {
    expect(nameCollision("launch-2026", projects).collides).toBe(true);
  });

  it("folds case and punctuation before comparing", () => {
    expect(nameCollision("Launch 2026", projects).collides).toBe(true);
    expect(nameCollision("LAUNCH  2026!", projects).collides).toBe(true);
    expect(nameCollision("Showcase — Tour", projects).collides).toBe(true);
  });

  it("normalises the existing slugs too", () => {
    expect(nameCollision("Draft", [" Draft ", ""]).collides).toBe(true);
  });

  it("does not warn on a near miss", () => {
    expect(nameCollision("Launch 2027", projects).collides).toBe(false);
    expect(nameCollision("launch2026", projects).collides).toBe(false);
  });

  it("excludes the renamed item's own slug", () => {
    expect(nameCollision("Launch 2026", projects, { selfSlug: "launch-2026" })).toEqual({
      slug: "launch-2026",
      collides: false,
    });
    expect(nameCollision("Launch 2026", projects, { selfSlug: "Launch-2026" }).collides).toBe(
      false,
    );
    // Excluding yourself never hides someone else's clash.
    expect(nameCollision("Showcase Tour", projects, { selfSlug: "launch-2026" }).collides).toBe(
      true,
    );
  });

  it("treats a name with nothing sluggable as no name at all", () => {
    for (const name of ["", "   ", "!!!", "—"]) {
      expect(nameCollision(name, projects)).toEqual({ slug: "", collides: false });
    }
    expect(nameCollision("", [""]).collides).toBe(false);
  });

  it("takes no existing slugs at all", () => {
    expect(nameCollision("Anything", [])).toEqual({ slug: "anything", collides: false });
  });

  it("honours a caller's own slug rules", () => {
    const slugify = (name: string) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 8);
    expect(nameCollision("LinkedIn Tight Crop", ["linkedin"], { slugify })).toEqual({
      slug: "linkedin",
      collides: true,
    });
  });
});

describe("nameCollisionWarning", () => {
  it("names the thing and the slug", () => {
    expect(nameCollisionWarning("project", "launch-2026")).toBe(
      "A project named “launch-2026” already exists.",
    );
    expect(nameCollisionWarning("theme", "midnight")).toBe(
      "A theme named “midnight” already exists.",
    );
  });
});
