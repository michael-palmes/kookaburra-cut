import { describe, expect, it } from "vitest";
import type { FormatInfo } from "../toolkit/types";
import {
  deriveManagedTextModel,
  managedTextOwnsScene,
  materialiseManagedText,
  resolveManagedTextRenderPlan,
  shouldRenderManagedTextRole,
} from "./managedText";
import type { SceneDoc } from "./sceneDocSchema";

const landscape: FormatInfo = {
  width: 1920,
  height: 1080,
  aspect: 16 / 9,
  frame: { width: 5.33, height: 3 },
  safe: { top: 0.2, right: 0.25, bottom: 0.2, left: 0.25 },
};

const portrait: FormatInfo = {
  width: 1080,
  height: 1920,
  aspect: 9 / 16,
  frame: { width: 1.69, height: 3 },
  safe: { top: 0.2, right: 0.12, bottom: 0.2, left: 0.12 },
};

describe("managed text ownership", () => {
  it("distinguishes an absent block from a present-empty block", () => {
    const authored: SceneDoc = { version: 1, text: { title: "Authored" } };
    const empty: SceneDoc = { ...authored, managedText: { items: [] } };
    expect(managedTextOwnsScene(authored)).toBe(false);
    expect(managedTextOwnsScene(empty)).toBe(true);
    expect(shouldRenderManagedTextRole(authored, "scene")).toBe(true);
    expect(shouldRenderManagedTextRole(empty, "scene")).toBe(false);
    expect(shouldRenderManagedTextRole(empty, "embedded")).toBe(true);
    expect(shouldRenderManagedTextRole(empty, "managed")).toBe(true);
    expect(resolveManagedTextRenderPlan(authored, landscape, 1.25)).toEqual({
      ownsSceneText: false,
      nodes: [],
      fit: 1,
    });
    expect(resolveManagedTextRenderPlan(empty, landscape, 1.25)).toEqual({
      ownsSceneText: true,
      nodes: [],
      fit: 1,
    });
  });

  it("leaves a supplied overlay region on the exact code-authored fallback path", () => {
    const authored: SceneDoc = { version: 1, text: { title: "Overlay-owned title" } };
    expect(
      resolveManagedTextRenderPlan(authored, landscape, 1.25, {
        left: -2,
        top: 1,
        bottom: -1,
        width: 1.4,
        align: "left",
      }),
    ).toEqual({ ownsSceneText: false, nodes: [], fit: 1 });
  });

  it("derives resolved registrations, fallback-only copy, an icon and bullet structure in order", () => {
    const doc: SceneDoc = {
      version: 1,
      headerIcon: "🐨",
      text: { title: "Resolved title", bullets: "One\nTwo", extra: "Extra line" },
    };
    const model = deriveManagedTextModel(doc, [
      { key: "title", text: "Resolved title" },
      { key: "body", text: "Mounted fallback" },
      { key: "bullets", text: "One\nTwo" },
    ]);
    expect(model.ownership).toBe("authored");
    expect(model.items.map(({ key, type }) => [key, type])).toEqual([
      ["icon", "icon"],
      ["title", "title"],
      ["body", "subtitle"],
      ["bullets", "bullets"],
      ["extra", "title"],
    ]);
    expect(model.items[3].points).toEqual([
      { key: "bullets-point-1", text: "One" },
      { key: "bullets-point-2", text: "Two" },
    ]);
  });

  it("keeps an existing managed block authoritative, including dormant fields", () => {
    const items = [
      {
        key: "hero",
        type: "subtitle" as const,
        text: "Copy",
        icon: "assets/mark.png",
        points: [{ key: "p1", text: "Dormant point" }],
      },
    ];
    const doc: SceneDoc = { version: 1, managedText: { items } };
    const model = deriveManagedTextModel(doc, [{ key: "other", text: "Ignored" }]);
    expect(model).toEqual({ ownership: "managed", items });
    expect(model.items).toBe(items);
  });

  it("materialises once while retaining the exact authored fields for removal or Undo", () => {
    const text = { title: "Authored" };
    const style = { titleColor: "accent" };
    const animation = { in: "fade-up", out: "none", staggerMs: 0 };
    const doc: SceneDoc = { version: 1, text, textStyle: style, textAnimation: animation };
    const next = materialiseManagedText(doc, deriveManagedTextModel(doc));
    expect(next).not.toBe(doc);
    expect(next.text).toBe(text);
    expect(next.textStyle).toBe(style);
    expect(next.textAnimation).toBe(animation);
    expect(next.managedText?.items).toEqual([{ key: "title", type: "title", text: "Authored" }]);
    const second = materialiseManagedText(next, { ownership: "authored", items: [] });
    expect(second).toBe(next);
  });

  it("captures resolved coded style and motion as keyed takeover data", () => {
    const doc: SceneDoc = { version: 1, textStyle: { heroColor: "accent" } };
    const model = deriveManagedTextModel(doc, [
      {
        key: "hero",
        text: "Hello",
        style: { color: "#123456", font: "Inter@700", size: 1.2, offsetX: 0.1 },
        motion: {
          in: "twist-scale",
          out: "fade",
          staggerMs: 0,
          durationMs: 500,
          ease: "outExpo",
        },
      },
    ]);
    expect(model.textStyle).toEqual({
      heroColor: "#123456",
      heroFont: "Inter@700",
      heroSize: 1.2,
      heroOffsetX: 0.1,
    });
    const next = materialiseManagedText(doc, model);
    expect(next.textStyle?.heroColor).toBe("accent");
    expect(next.textStyle?.heroFont).toBe("Inter@700");
    expect(next.textAnimationOverrides?.hero).toMatchObject({
      in: "twist-scale",
      durationMs: 500,
      ease: "outExpo",
    });
  });

  it("prefers the queued sidecar copy over a stale mounted fallback snapshot", () => {
    const model = deriveManagedTextModel(
      { version: 1, text: { title: "Edited immediately before takeover" } },
      [{ key: "title", text: "Older mounted fallback" }],
    );

    expect(model.items).toEqual([
      { key: "title", type: "title", text: "Edited immediately before takeover" },
    ]);
  });
});

describe("managed text render data", () => {
  const doc: SceneDoc = {
    version: 1,
    managedText: {
      items: [
        { key: "title-a", type: "title", text: "First title" },
        { key: "title-b", type: "title", text: "Second title" },
        { key: "subtitle", type: "subtitle", text: "Supporting copy" },
        {
          key: "points",
          type: "bullets",
          marker: "number",
          pointGap: 0.08,
          indent: 0.22,
          points: [
            { key: "first", text: "One" },
            { key: "second", text: "Two" },
          ],
        },
        { key: "mark", type: "icon", icon: "assets/mark.png" },
      ],
    },
  };

  it("emits all four item types, repeated types and stable bullet node keys", () => {
    const plan = resolveManagedTextRenderPlan(doc, landscape, 1.25);
    expect(plan.ownsSceneText).toBe(true);
    expect(plan.nodes.filter((node) => node.kind === "title")).toHaveLength(2);
    expect(plan.nodes.some((node) => node.kind === "subtitle")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "icon" && node.icon === "assets/mark.png")).toBe(
      true,
    );
    expect(plan.nodes.find((node) => node.key === "points:first:marker")?.text).toBe("1.");
    expect(plan.nodes.find((node) => node.key === "points:second:marker")?.text).toBe("2.");
    expect(plan.nodes.find((node) => node.key === "points:second:text")?.itemKey).toBe("points");
  });

  it("uses resolved by-line stagger across items and pairs bullet markers with their text", () => {
    const withByLine: SceneDoc = {
      ...doc,
      textAnimation: {
        in: "fade-up",
        out: "none",
        staggerMs: 125,
        delivery: "by-paragraph",
      },
    };
    const byLine = resolveManagedTextRenderPlan(withByLine, landscape, 1.25);
    const firstTitle = byLine.nodes.find((node) => node.key === "title-a");
    const secondTitle = byLine.nodes.find((node) => node.key === "title-b");
    const subtitle = byLine.nodes.find((node) => node.key === "subtitle");
    const first = byLine.nodes.find((node) => node.key === "points:first:text");
    const second = byLine.nodes.find((node) => node.key === "points:second:text");
    const firstMarker = byLine.nodes.find((node) => node.key === "points:first:marker");
    const secondMarker = byLine.nodes.find((node) => node.key === "points:second:marker");
    expect((secondTitle?.from ?? 0) - (firstTitle?.from ?? 0)).toBe(125);
    expect((subtitle?.from ?? 0) - (secondTitle?.from ?? 0)).toBe(125);
    expect((first?.from ?? 0) - (subtitle?.from ?? 0)).toBe(125);
    expect((second?.from ?? 0) - (first?.from ?? 0)).toBe(125);
    expect((second?.to ?? 0) - (first?.to ?? 0)).toBe(125);
    expect(firstMarker?.from).toBe(first?.from);
    expect(firstMarker?.to).toBe(first?.to);
    expect(secondMarker?.from).toBe(second?.from);
    expect(secondMarker?.to).toBe(second?.to);
  });

  it("keeps every managed item simultaneous for all-at-once delivery", () => {
    const allAtOnce = resolveManagedTextRenderPlan(
      {
        ...doc,
        textAnimation: { in: "fade", out: "none", staggerMs: 900, delivery: "all-at-once" },
      },
      landscape,
      1.25,
    );
    expect(new Set(allAtOnce.nodes.map((node) => node.from))).toEqual(new Set([200]));
    expect(new Set(allAtOnce.nodes.map((node) => node.to))).toEqual(new Set([900]));
  });

  it("inherits by-line delivery from the theme and retains an item exception", () => {
    const plan = resolveManagedTextRenderPlan(doc, landscape, 1.25, undefined, {
      in: "fade-up",
      out: "none",
      staggerMs: 90,
      delivery: "by-paragraph",
    });
    const firstTitle = plan.nodes.find((node) => node.key === "title-a");
    const secondTitle = plan.nodes.find((node) => node.key === "title-b");
    const first = plan.nodes.find((node) => node.key === "points:first:text");
    const second = plan.nodes.find((node) => node.key === "points:second:text");
    expect((secondTitle?.from ?? 0) - (firstTitle?.from ?? 0)).toBe(90);
    expect((second?.from ?? 0) - (first?.from ?? 0)).toBe(90);

    const excepted = resolveManagedTextRenderPlan(
      {
        ...doc,
        textAnimationOverrides: {
          points: { in: "fade", out: "none", staggerMs: 900, delivery: "all-at-once" },
        },
      },
      landscape,
      1.25,
      undefined,
      {
        in: "fade-up",
        out: "none",
        staggerMs: 90,
        delivery: "by-paragraph",
      },
    );
    const bulletNodes = excepted.nodes.filter((node) => node.itemKey === "points");
    expect(new Set(bulletNodes.map((node) => node.from))).toEqual(new Set([200]));
    expect(new Set(bulletNodes.map((node) => node.to))).toEqual(new Set([900]));
  });

  it("fits landscape and portrait plans inside their safe vertical regions deterministically", () => {
    for (const format of [landscape, portrait]) {
      const a = resolveManagedTextRenderPlan(doc, format, 1.25);
      const b = resolveManagedTextRenderPlan(doc, format, 1.25);
      expect(a).toEqual(b);
      expect(a.fit).toBeGreaterThan(0);
      expect(a.fit).toBeLessThanOrEqual(1);
      for (const node of a.nodes) {
        expect(node.position[1]).toBeLessThanOrEqual(format.frame.height / 2 - format.safe.top);
        expect(node.position[1]).toBeGreaterThanOrEqual(
          -format.frame.height / 2 + format.safe.bottom,
        );
      }
    }
  });

  it("uses a supplied overlay region and preserves local style nudges outside sibling flow", () => {
    const styled: SceneDoc = {
      ...doc,
      textStyle: { "title-aOffsetX": 1, "title-aOffsetY": -1, "title-aSize": 1.8 },
    };
    const region = { left: 1.2, top: 1.1, bottom: -1.1, width: 1.4, align: "left" as const };
    const base = resolveManagedTextRenderPlan(doc, landscape, 1.25, region);
    const withNudge = resolveManagedTextRenderPlan(styled, landscape, 1.25, region);
    expect(withNudge).toEqual(base);
    expect(base.nodes[0].position[0]).toBe(region.left);
  });
});
