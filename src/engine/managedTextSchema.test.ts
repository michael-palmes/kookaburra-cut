import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSceneDoc } from "./sceneDocSchema";

describe("managed text scene schema", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  it("preserves a present-empty block", () => {
    expect(parseSceneDoc({ version: 1, managedText: { items: [] } }, "test")?.managedText).toEqual({
      items: [],
    });
  });

  it("preserves the template layout without changing generic managed blocks", () => {
    expect(
      parseSceneDoc({ version: 1, managedText: { layout: "template", items: [] } }, "test")
        ?.managedText,
    ).toEqual({ layout: "template", items: [] });
    expect(
      parseSceneDoc({ version: 1, managedText: { layout: "unknown", items: [] } }, "test")
        ?.managedText,
    ).toEqual({ items: [] });
    expect(warn).toHaveBeenCalled();
  });

  it("parses all item fields and retains dormant settings", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        managedText: {
          items: [
            {
              key: "hero",
              type: "title",
              text: "Hello",
              icon: "🐨",
              points: [{ key: "p1", text: "Point" }],
              marker: "tick",
              pointGap: 0.08,
              indent: 0.22,
            },
          ],
        },
      },
      "test",
    );
    expect(doc?.managedText?.items[0]).toEqual({
      key: "hero",
      type: "title",
      text: "Hello",
      icon: "🐨",
      points: [{ key: "p1", text: "Point" }],
      marker: "tick",
      pointGap: 0.08,
      indent: 0.22,
    });
  });

  it("parses valid groups while dropping malformed, duplicate and unknown references", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        managedText: {
          groups: [
            { key: "hero", itemKeys: ["title"], align: "right" },
            { key: "missing-items" },
            { key: "hero", itemKeys: ["subtitle"] },
            {
              key: "supporting",
              itemKeys: ["subtitle", "unknown", "title"],
              align: "diagonal",
            },
          ],
          items: [
            { key: "title", type: "title", text: "Title" },
            { key: "subtitle", type: "subtitle", text: "Subtitle" },
            { key: "orphan", type: "title", text: "Still retained" },
          ],
        },
      },
      "test",
    );

    expect(doc?.managedText).toEqual({
      groups: [
        { key: "hero", itemKeys: ["title"], align: "right" },
        { key: "supporting", itemKeys: ["subtitle"] },
      ],
      items: [
        { key: "title", type: "title", text: "Title" },
        { key: "subtitle", type: "subtitle", text: "Subtitle" },
        { key: "orphan", type: "title", text: "Still retained" },
      ],
    });
    expect(warn).toHaveBeenCalled();
  });

  it("drops malformed and duplicate entries without dropping valid siblings", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        managedText: {
          items: [
            { key: "same", type: "title", text: "Kept" },
            { key: "same", type: "subtitle", text: "Dropped" },
            { key: "bad", type: "unknown", text: "Dropped" },
          ],
        },
      },
      "test",
    );
    expect(doc?.managedText?.items).toEqual([{ key: "same", type: "title", text: "Kept" }]);
    expect(warn).toHaveBeenCalled();
  });

  it("parses keyed motion plus duration, distance and easing field by field", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        textAnimation: {
          in: "fade-up",
          out: "fade",
          staggerMs: 80,
          durationMs: 450,
          distance: 0.3,
          ease: "outExpo",
        },
        textAnimationOverrides: {
          hero: {
            in: "static",
            out: "static",
            staggerMs: 0,
            durationMs: 300,
            distance: 0,
            ease: "linear",
          },
          bad: { in: "fade" },
        },
      },
      "test",
    );
    expect(doc?.textAnimation).toMatchObject({ durationMs: 450, distance: 0.3, ease: "outExpo" });
    expect(doc?.textAnimationOverrides).toEqual({
      hero: {
        in: "static",
        out: "static",
        staggerMs: 0,
        durationMs: 300,
        distance: 0,
        ease: "linear",
      },
    });
  });
});
