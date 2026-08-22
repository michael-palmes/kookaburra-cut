import { describe, expect, it } from "vitest";
import type { FormatInfo } from "../toolkit/types";
import {
  clearTemplateManagedTextLayout,
  deriveManagedTextModel,
  frameIconMotionKey,
  frameIconRenderRole,
  frameIconStyleKey,
  isTemplateManagedText,
  managedFrameIconItemKey,
  managedTextOwnsScene,
  materialiseManagedText,
  resolveManagedTextGroups,
  resolveManagedTextRenderPlan,
  resolveSpecialisedTextCopy,
  resolveTemplateManagedFrameIcon,
  resolveTemplateManagedTextBullets,
  resolveTemplateManagedTextCopy,
  resolveTemplateManagedTextIcon,
  shouldRenderManagedTextHeadline,
  shouldRenderManagedTextRole,
  specialisedBrandLockupMode,
  specialisedClaimedTextMode,
  templateManagedTextHasExplicitMotion,
  templateManagedTextOverridesCodedMotion,
  usesSpecialisedTextRenderer,
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
  it("resolves an absent groups field as one implicit compatibility group", () => {
    const items = [
      { key: "title", type: "title" as const, text: "Title" },
      { key: "subtitle", type: "subtitle" as const, text: "Subtitle" },
    ];

    expect(resolveManagedTextGroups(items)).toEqual([
      {
        key: "text",
        itemKeys: ["title", "subtitle"],
        items,
        implicit: true,
      },
    ]);
  });

  it("projects legacy bullet copy as stable points without mutating the document", () => {
    const item = { key: "bullets", type: "bullets" as const, text: "First\nSecond" };
    const doc: SceneDoc = { version: 1, managedText: { items: [item] } };

    expect(resolveManagedTextGroups(doc.managedText?.items ?? [])[0]?.items[0]?.points).toEqual([
      { key: "bullets-point-1", text: "First" },
      { key: "bullets-point-2", text: "Second" },
    ]);
    expect(resolveManagedTextRenderPlan(doc, landscape, 1.25).nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "bullets:bullets-point-1:text", text: "First" }),
        expect.objectContaining({ key: "bullets:bullets-point-2:text", text: "Second" }),
      ]),
    );
    expect(item).not.toHaveProperty("points");
  });

  it("retains explicit group order and alignment, then appends a collision-safe residual group", () => {
    const title = { key: "title", type: "title" as const, text: "Title" };
    const subtitle = { key: "subtitle", type: "subtitle" as const, text: "Subtitle" };
    const orphan = { key: "orphan", type: "title" as const, text: "Orphan" };

    expect(
      resolveManagedTextGroups(
        [title, subtitle, orphan],
        [
          { key: "text", itemKeys: ["title"], align: "right" },
          { key: "supporting", itemKeys: ["subtitle"], align: "left" },
        ],
      ),
    ).toEqual([
      {
        key: "text",
        itemKeys: ["title"],
        items: [title],
        align: "right",
        implicit: false,
      },
      {
        key: "supporting",
        itemKeys: ["subtitle"],
        items: [subtitle],
        align: "left",
        implicit: false,
      },
      {
        key: "text-2",
        itemKeys: ["orphan"],
        items: [orphan],
        implicit: false,
      },
    ]);
  });

  it("keeps reserved frame chrome outside Content groups", () => {
    const frameIcon = { key: "frameIcon", type: "icon" as const, icon: "assets/frame.png" };
    const sceneIcon = { key: "icon", type: "icon" as const, icon: "🪄" };
    const title = { key: "title", type: "title" as const, text: "Launch" };

    expect(resolveManagedTextGroups([frameIcon, sceneIcon, title])).toEqual([
      {
        key: "text",
        itemKeys: ["icon", "title"],
        items: [sceneIcon, title],
        implicit: true,
      },
    ]);
    expect(
      resolveManagedTextGroups(
        [frameIcon, sceneIcon, title],
        [{ key: "text", itemKeys: ["frameIcon", "icon", "title"] }],
      ),
    ).toEqual([
      {
        key: "text",
        itemKeys: ["icon", "title"],
        items: [sceneIcon, title],
        implicit: false,
      },
    ]);
  });

  it("distinguishes an absent block from a present-empty block", () => {
    const authored: SceneDoc = { version: 1, text: { title: "Authored" } };
    const empty: SceneDoc = { ...authored, managedText: { items: [] } };
    expect(managedTextOwnsScene(authored)).toBe(false);
    expect(managedTextOwnsScene(empty)).toBe(true);
    expect(usesSpecialisedTextRenderer(authored)).toBe(true);
    expect(usesSpecialisedTextRenderer(empty)).toBe(false);
    expect(shouldRenderManagedTextRole(authored, "scene")).toBe(true);
    expect(shouldRenderManagedTextRole(empty, "scene")).toBe(false);
    expect(shouldRenderManagedTextRole(empty, "embedded")).toBe(true);
    expect(shouldRenderManagedTextRole(empty, "managed")).toBe(true);
    expect(shouldRenderManagedTextHeadline(authored, "scene", true)).toBe(false);
    expect(shouldRenderManagedTextHeadline(authored, "embedded", true)).toBe(true);
    expect(shouldRenderManagedTextHeadline(empty, "managed", true)).toBe(true);
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

  it("keeps panel chrome visible through generic managed ownership", () => {
    const template: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "frameIcon", type: "icon", icon: "assets/frame.png" }],
      },
    };
    const generic = clearTemplateManagedTextLayout(template);

    expect(frameIconRenderRole(undefined, true)).toBe("scene");
    expect(frameIconRenderRole(template, true)).toBe("scene");
    expect(frameIconRenderRole(generic, true)).toBe("managed");
    expect(frameIconRenderRole(generic, false)).toBe("embedded");
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

  it("keeps template-managed items authoritative while retaining the authored renderer", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { title: "Stale title", subtitle: "Stale subtitle", bullets: "Stale point" },
      headerIcon: "🐨",
      managedText: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "assets/managed.png" },
          { key: "title", type: "title", text: "Managed title" },
          { key: "subtitle", type: "subtitle", text: "" },
          {
            key: "bullets",
            type: "bullets",
            points: [
              { key: "one", text: " First " },
              { key: "blank", text: "  " },
              { key: "two", text: "Second" },
            ],
          },
        ],
      },
    };

    expect(isTemplateManagedText(doc)).toBe(true);
    expect(usesSpecialisedTextRenderer(doc)).toBe(true);
    expect(shouldRenderManagedTextRole(doc, "scene")).toBe(true);
    expect(resolveTemplateManagedTextCopy(doc, "title", "Fallback")).toBe("Managed title");
    expect(resolveTemplateManagedTextCopy(doc, "subtitle", "Fallback")).toBe("");
    expect(resolveTemplateManagedTextCopy(doc, "missing", "Fallback")).toBe("");
    expect(resolveSpecialisedTextCopy(doc, "title", "Fallback")).toBe("Managed title");
    expect(resolveTemplateManagedTextIcon(doc, "icon", "Fallback")).toBe("assets/managed.png");
    expect(resolveTemplateManagedTextBullets(doc, "bullets", "Fallback")).toEqual([
      "First",
      "Second",
    ]);
    expect(templateManagedTextHasExplicitMotion(doc, "icon")).toBe(false);
    expect(
      templateManagedTextHasExplicitMotion(
        {
          ...doc,
          textAnimationOverrides: {
            icon: { in: "fade-up", out: "none", staggerMs: 0 },
          },
        },
        "icon",
      ),
    ).toBe(true);
    const globalMotion: SceneDoc = {
      ...doc,
      textAnimation: { in: "fade", out: "none", staggerMs: 0 },
    };
    expect(templateManagedTextOverridesCodedMotion(globalMotion, "icon")).toBe(false);
    expect(
      templateManagedTextOverridesCodedMotion(
        {
          ...globalMotion,
          textAnimationOverrides: {
            icon: { in: "fade-up", out: "none", staggerMs: 0 },
          },
        },
        "icon",
      ),
    ).toBe(true);
    expect(
      templateManagedTextOverridesCodedMotion(
        { ...globalMotion, textAnimationForce: true },
        "icon",
      ),
    ).toBe(true);
    expect(
      templateManagedTextHasExplicitMotion(
        {
          ...doc,
          textAnimation: { in: "fade", out: "none", staggerMs: 0 },
        },
        "icon",
      ),
    ).toBe(true);
    expect(resolveManagedTextRenderPlan(doc, landscape, 1.25)).toEqual({
      ownsSceneText: true,
      nodes: [],
      fit: 1,
    });

    const generic = clearTemplateManagedTextLayout(doc);
    expect(generic).not.toBe(doc);
    expect(generic.managedText).toEqual({ items: doc.managedText?.items });
    expect(isTemplateManagedText(generic)).toBe(false);
    expect(resolveSpecialisedTextCopy(generic, "title", "Stale title")).toBe("");
    expect(clearTemplateManagedTextLayout(generic)).toBe(generic);
  });

  it("keeps frame and scene icons separate under a claimed specialised layout", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
          { key: "icon", type: "icon", icon: "🪄" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
    };

    expect(resolveTemplateManagedFrameIcon(doc, "Fallback")).toBe("assets/frame.png");
    expect(resolveTemplateManagedTextIcon(doc, "icon", "Fallback")).toBe("🪄");
    expect(specialisedClaimedTextMode(doc, true)).toBe("icon-only");
    expect(specialisedClaimedTextMode(doc, false)).toBe("all");
    expect(specialisedBrandLockupMode(doc, true)).toBe("icon-only");

    const generic = clearTemplateManagedTextLayout(doc);
    expect(resolveTemplateManagedFrameIcon(generic, "Fallback")).toBe("assets/frame.png");
    expect(resolveManagedTextRenderPlan(generic, landscape, 1).nodes).toEqual([
      expect.objectContaining({ itemKey: "icon", kind: "icon", icon: "🪄" }),
      expect.objectContaining({ itemKey: "title", kind: "title", text: "Launch" }),
    ]);
  });

  it("retains legacy icon fallback and absent-document claimed behaviour", () => {
    const legacyTemplate: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "icon", type: "icon", icon: "assets/legacy-frame.png" }],
      },
    };
    expect(resolveTemplateManagedFrameIcon(legacyTemplate, "assets/legacy-frame.png")).toBe(
      "assets/legacy-frame.png",
    );
    expect(managedFrameIconItemKey(legacyTemplate, "assets/legacy-frame.png")).toBe("icon");
    expect(resolveTemplateManagedFrameIcon(legacyTemplate, "assets/later-frame.png")).toBe(
      "assets/later-frame.png",
    );
    expect(managedFrameIconItemKey(legacyTemplate, "assets/later-frame.png")).toBeUndefined();
    expect(specialisedClaimedTextMode(legacyTemplate, true)).toBe("none");
    expect(specialisedClaimedTextMode(undefined, true)).toBe("none");
    expect(specialisedBrandLockupMode(legacyTemplate, true)).toBe("all");
    expect(specialisedBrandLockupMode(undefined, true)).toBe("all");
    expect(
      resolveTemplateManagedFrameIcon(
        { version: 1, managedText: { items: [{ key: "title", type: "title", text: "Text" }] } },
        "assets/deck.png",
      ),
    ).toBeUndefined();

    const dualIconTemplate: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
          { key: "icon", type: "icon", icon: "🪄" },
        ],
      },
    };
    expect(managedFrameIconItemKey(dualIconTemplate)).toBe("frameIcon");
    expect(
      managedFrameIconItemKey({
        version: 1,
        managedText: {
          groups: [{ key: "text", itemKeys: ["icon"] }],
          items: [{ key: "icon", type: "icon", icon: "🪄" }],
        },
      }),
    ).toBeUndefined();
  });

  it("preserves an explicitly empty dedicated frame icon", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "frameIcon", type: "icon", icon: "" },
          { key: "icon", type: "icon", icon: "🪄" },
        ],
      },
    };
    expect(resolveTemplateManagedFrameIcon(doc, "assets/deck.png")).toBe("");
  });

  it("reserves legacy panel chrome before leaving a template layout", () => {
    const motion = { in: "fade-up", out: "none", staggerMs: 40 } as const;
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        groups: [{ key: "text", itemKeys: ["icon", "title"] }],
        items: [
          { key: "icon", type: "icon", icon: "assets/legacy-frame.png" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
      textStyle: { iconSize: 1.4, iconOffsetY: 0.2, titleSize: 1.1 },
      textAnimationOverrides: { icon: motion },
    };

    const generic = clearTemplateManagedTextLayout(doc, {
      icon: "assets/legacy-frame.png",
      reserveLegacyFrameIcon: true,
    });
    expect(generic.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["title"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/legacy-frame.png" },
        { key: "title", type: "title", text: "Launch" },
      ],
    });
    expect(generic.textStyle).toEqual({
      frameIconSize: 1.4,
      frameIconOffsetY: 0.2,
      titleSize: 1.1,
    });
    expect(generic.textAnimationOverrides).toEqual({ frameIcon: motion });
    expect(resolveTemplateManagedFrameIcon(generic, "Fallback")).toBe("assets/legacy-frame.png");
    expect(
      resolveManagedTextGroups(generic.managedText?.items ?? [], generic.managedText?.groups),
    ).toEqual([
      {
        key: "text",
        itemKeys: ["title"],
        items: [{ key: "title", type: "title", text: "Launch" }],
        implicit: false,
      },
    ]);
    expect(doc.managedText?.layout).toBe("template");
    expect(doc.managedText?.items[0]?.key).toBe("icon");
    expect(doc.textStyle).toHaveProperty("iconSize", 1.4);
  });

  it("keeps legacy frame style and motion keys until their new stable fields are used", () => {
    const legacy: SceneDoc = {
      version: 1,
      textStyle: { iconSize: 1.5 },
      textAnimationOverrides: { icon: { in: "fade", out: "none", staggerMs: 0 } },
    };
    expect(frameIconStyleKey(legacy)).toBe("icon");
    expect(frameIconMotionKey(legacy)).toBe("icon");
    expect(frameIconStyleKey({ ...legacy, textStyle: { frameIconSize: 1.2 } })).toBe("frameIcon");
    expect(
      frameIconMotionKey({
        ...legacy,
        textAnimationOverrides: {
          frameIcon: { in: "fade-up", out: "none", staggerMs: 0 },
        },
      }),
    ).toBe("frameIcon");
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

  it("projects a stable empty frame icon separately from a mounted scene icon", () => {
    const model = deriveManagedTextModel(
      { version: 1, headerIcon: "🪄" },
      [{ key: "icon", text: "", type: "icon", icon: "🪄" }],
      { icon: "", iconKey: "frameIcon" },
    );
    expect(model.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "" },
      { key: "icon", type: "icon", icon: "🪄" },
    ]);
  });

  it("retains a legacy TitleBlock header icon beside a projected claiming frame", () => {
    const model = deriveManagedTextModel(
      { version: 1, headerIcon: "🪄", text: { title: "Launch" } },
      [{ key: "title", text: "Launch", type: "title" }],
      { icon: "assets/frame.png", iconKey: "frameIcon" },
    );
    expect(model.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
      { key: "icon", type: "icon", icon: "🪄" },
      { key: "title", type: "title", text: "Launch" },
    ]);
  });

  it("deduplicates a legacy claiming frame registration against its projected item", () => {
    const model = deriveManagedTextModel(
      { version: 1, text: { title: "Launch" } },
      [
        { key: "frameIcon", text: "", type: "icon", icon: "assets/frame.png" },
        { key: "title", text: "Launch", type: "title" },
      ],
      { icon: "assets/frame.png", iconKey: "frameIcon" },
    );
    expect(model.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
      { key: "title", type: "title", text: "Launch" },
    ]);
  });

  it("excludes mounted embedded copy without dropping unmounted sidecar fallback text", () => {
    const model = deriveManagedTextModel(
      {
        version: 1,
        text: {
          title: "Scene title",
          beforeLabel: "Before",
          sidecarOnly: "Still editable",
        },
      },
      [{ key: "title", text: "Scene title" }],
      { excludedKeys: ["beforeLabel"] },
    );

    expect(model.items.map(({ key }) => key)).toEqual(["title", "sidecarOnly"]);
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

  it("exposes coded defaults for matching template items without changing their data", () => {
    const items = [{ key: "title", type: "subtitle" as const, text: "Kookaburra" }];
    const registration = {
      key: "title",
      text: "Ignored copy",
      style: { color: "muted", font: "Inter@500", size: 0.72 },
      motion: { in: "fade-scale" as const, out: "none" as const, staggerMs: 0 },
    };
    const template = deriveManagedTextModel(
      { version: 1, managedText: { layout: "template", items } },
      [registration, { ...registration, key: "not-an-item" }],
    );
    const generic = deriveManagedTextModel({ version: 1, managedText: { items } }, [registration]);

    expect(template).toEqual({
      ownership: "managed",
      items,
      textStyle: { titleColor: "muted", titleFont: "Inter@500", titleSize: 0.72 },
      textAnimationOverrides: { title: registration.motion },
    });
    expect(template.items).toBe(items);
    expect(generic).toEqual({ ownership: "managed", items });
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

  it("drops phantom blank mounts but retains explicit blank copy, icons and points", () => {
    const model = deriveManagedTextModel({ version: 1, text: { explicit: "" } }, [
      { key: "phantom", text: "  " },
      { key: "explicit", text: "stale" },
      { key: "icon", text: "", type: "icon", icon: "🐨" },
      { key: "points", text: "", type: "bullets", points: [{ key: "p1", text: "" }] },
    ]);

    expect(model.items.map(({ key }) => key)).toEqual(["explicit", "icon", "points"]);
    expect(model.items[0]?.text).toBe("");
  });
});

describe("comparison chip rows", () => {
  const chipsOn: SceneDoc = { version: 1, compare: { chrome: { chips: true } } };

  it("adds one editable item per chip, and none with chips off", () => {
    expect(deriveManagedTextModel(chipsOn, [{ key: "title", text: "Scene title" }]).items).toEqual([
      { key: "title", type: "title", text: "Scene title" },
      { key: "beforeLabel", type: "subtitle", text: "Before" },
      { key: "afterLabel", type: "subtitle", text: "After" },
    ]);
    expect(
      deriveManagedTextModel({ version: 1, compare: { chrome: { chips: false } } }, []).items,
    ).toEqual([]);
  });

  it("never surfaces chip copy through the legacy sidecar fallback", () => {
    const model = deriveManagedTextModel({
      version: 1,
      text: { beforeLabel: "Orphaned", title: "Kept" },
    });

    expect(model.items.map(({ key }) => key)).toEqual(["title"]);
  });

  it("takes the chip copy from the sidecar when it has some", () => {
    const model = deriveManagedTextModel({ ...chipsOn, text: { beforeLabel: "Pre-launch" } });

    expect(model.items).toEqual([
      { key: "beforeLabel", type: "subtitle", text: "Pre-launch" },
      { key: "afterLabel", type: "subtitle", text: "After" },
    ]);
  });

  it("keeps the rows after a managed takeover without joining the block", () => {
    const managed: SceneDoc = {
      ...chipsOn,
      managedText: { items: [{ key: "title", type: "title", text: "Owned" }] },
    };
    const model = deriveManagedTextModel(managed);

    expect(model.ownership).toBe("managed");
    expect(model.items.map(({ key }) => key)).toEqual(["title", "beforeLabel", "afterLabel"]);
    expect(managed.managedText?.items.map(({ key }) => key)).toEqual(["title"]);
  });

  it("leaves the chips out of the block a takeover writes", () => {
    const doc: SceneDoc = { ...chipsOn, text: { title: "Owned" } };
    const next = materialiseManagedText(doc, deriveManagedTextModel(doc));

    expect(next.managedText?.items).toEqual([{ key: "title", type: "title", text: "Owned" }]);
  });

  it("gives each chip its own labelled group, after the content groups", () => {
    const model = deriveManagedTextModel({ ...chipsOn, text: { title: "Owned" } });
    const groups = resolveManagedTextGroups(model.items, undefined);

    expect(groups.map((group) => group.key)).toEqual([
      "text",
      "compare-chip:beforeLabel",
      "compare-chip:afterLabel",
    ]);
    expect(groups[0]?.itemKeys).toEqual(["title"]);
    expect(groups[1]).toMatchObject({
      itemKeys: ["beforeLabel"],
      chrome: true,
      label: "Before label",
      implicit: false,
    });
    expect(groups[2]?.label).toBe("After label");
  });

  it("reads a raw block's items as owned, chip-named or not", () => {
    const items = [{ key: "beforeLabel", type: "title" as const, text: "Authored by hand" }];

    expect(resolveManagedTextGroups(items, undefined, [])).toEqual([
      { key: "text", itemKeys: ["beforeLabel"], items, implicit: true },
    ]);
  });

  it("keeps the safe-area stack out of chip rendering", () => {
    const plan = resolveManagedTextRenderPlan(
      {
        ...chipsOn,
        managedText: { items: [{ key: "title", type: "title", text: "Owned" }] },
      },
      landscape,
      1,
    );

    expect(plan.nodes.map((node) => node.itemKey)).toEqual(["title"]);
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

  it("does not render dormant text through an explicitly cleared icon", () => {
    const cleared: SceneDoc = {
      version: 1,
      managedText: {
        items: [{ key: "mark", type: "icon", icon: "", text: "Dormant title" }],
      },
    };

    expect(resolveManagedTextRenderPlan(cleared, landscape, 1.25)).toMatchObject({
      ownsSceneText: true,
      nodes: [],
    });
  });

  it("keeps legacy no-groups positions on the original single-stack path", () => {
    const legacy: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "first", type: "title", text: "First" },
          { key: "second", type: "title", text: "Second" },
        ],
      },
    };
    const region = { left: -1, top: 1, bottom: -1, width: 2, align: "center" as const };
    const plan = resolveManagedTextRenderPlan(legacy, landscape, 1.25, region);

    expect(plan.fit).toBe(1);
    expect(plan.nodes.map((node) => node.anchorX)).toEqual(["center", "center"]);
    expect(plan.nodes[0]?.position).toEqual([0, expect.closeTo(0.378, 10), 0]);
    expect(plan.nodes[1]?.position).toEqual([0, expect.closeTo(-0.0476, 10), 0]);
  });

  it("stacks explicit groups vertically with independent left and right alignment", () => {
    const grouped: SceneDoc = {
      version: 1,
      managedText: {
        groups: [
          { key: "first-group", itemKeys: ["first"], align: "left" },
          { key: "second-group", itemKeys: ["second"], align: "right" },
        ],
        items: [
          { key: "first", type: "title", text: "First" },
          { key: "second", type: "title", text: "Second" },
        ],
      },
    };
    const region = { left: -1, top: 1, bottom: -1, width: 2, align: "center" as const };
    const plan = resolveManagedTextRenderPlan(grouped, landscape, 1.25, region);
    const first = plan.nodes.find((node) => node.key === "first");
    const second = plan.nodes.find((node) => node.key === "second");

    expect(first).toMatchObject({ position: [-1, expect.any(Number), 0], anchorX: "left" });
    expect(second).toMatchObject({ position: [1, expect.any(Number), 0], anchorX: "right" });
    expect(first?.position[1]).toBeGreaterThan(second?.position[1] ?? Number.POSITIVE_INFINITY);
  });

  it("aligns explicit bullet groups from marker edge through text edge", () => {
    const grouped: SceneDoc = {
      version: 1,
      managedText: {
        groups: [
          { key: "centred", itemKeys: ["centre-points"], align: "center" },
          { key: "right", itemKeys: ["right-points"], align: "right" },
        ],
        items: [
          {
            key: "centre-points",
            type: "bullets",
            indent: 0.3,
            points: [{ key: "centre-point", text: "Centre" }],
          },
          {
            key: "right-points",
            type: "bullets",
            indent: 0.3,
            points: [{ key: "right-point", text: "Right" }],
          },
        ],
      },
    };
    const region = { left: -1, top: 1, bottom: -1, width: 2, align: "left" as const };
    const plan = resolveManagedTextRenderPlan(grouped, landscape, 1.25, region);
    const centreMarker = plan.nodes.find(
      (node) => node.key === "centre-points:centre-point:marker",
    );
    const centreText = plan.nodes.find((node) => node.key === "centre-points:centre-point:text");
    const rightText = plan.nodes.find((node) => node.key === "right-points:right-point:text");

    expect(centreMarker).toBeDefined();
    expect(centreText).toBeDefined();
    expect(
      (centreMarker?.position[0] ?? 0) +
        ((centreText?.position[0] ?? 0) +
          (centreText?.maxWidth ?? 0) -
          (centreMarker?.position[0] ?? 0)) /
          2,
    ).toBeCloseTo(0, 10);
    expect((rightText?.position[0] ?? 0) + (rightText?.maxWidth ?? 0)).toBeCloseTo(1, 10);
  });

  it("aligns explicit bullets from their fitted styled width when the stack shrinks", () => {
    const points = Array.from({ length: 12 }, (_, index) => ({
      key: `point-${index + 1}`,
      text: "Fit",
    }));
    const grouped: SceneDoc = {
      version: 1,
      managedText: {
        groups: [
          { key: "centred", itemKeys: ["centre-points"], align: "center" },
          { key: "right", itemKeys: ["right-points"], align: "right" },
        ],
        items: [
          { key: "centre-points", type: "bullets", marker: "none", points },
          { key: "right-points", type: "bullets", marker: "none", points },
        ],
      },
      textStyle: { "centre-pointsSize": 1.8, "right-pointsSize": 1.8 },
    };
    const region = { left: -1, top: 0.4, bottom: -0.4, width: 2, align: "left" as const };
    const plan = resolveManagedTextRenderPlan(grouped, landscape, 1.25, region);
    const centre = plan.nodes.find((node) => node.key === "centre-points:point-1:text");
    const right = plan.nodes.find((node) => node.key === "right-points:point-1:text");

    expect(plan.fit).toBeLessThan(1);
    for (const node of [centre, right]) {
      const renderedSize = (node?.fontSize ?? 0) * 1.8;
      expect(node?.maxWidth).toBeCloseTo("Fit".length * renderedSize * 0.56, 12);
    }
    expect((centre?.position[0] ?? 0) + (centre?.maxWidth ?? 0) / 2).toBeCloseTo(0, 12);
    expect((right?.position[0] ?? 0) + (right?.maxWidth ?? 0)).toBeCloseTo(1, 12);
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

  it("includes keyed Size and LineHeight in fit and flow without double-applying Size", () => {
    const region = { left: 1.2, top: 1.1, bottom: -1.1, width: 1.4, align: "left" as const };
    const base = resolveManagedTextRenderPlan(doc, landscape, 1.25, region);
    const sized = resolveManagedTextRenderPlan(
      { ...doc, textStyle: { "title-aSize": 1.8 } },
      landscape,
      1.25,
      region,
    );
    const styled = resolveManagedTextRenderPlan(
      {
        ...doc,
        textStyle: { "title-aSize": 1.8, "title-aLineHeight": 1.6 },
      },
      landscape,
      1.25,
      region,
    );
    const baseTitle = base.nodes.find((node) => node.key === "title-a");
    const styledTitle = styled.nodes.find((node) => node.key === "title-a");
    const baseSibling = base.nodes.find((node) => node.key === "title-b");
    const styledSibling = styled.nodes.find((node) => node.key === "title-b");

    expect(sized.fit).toBeLessThan(base.fit);
    expect(styled.fit).toBeLessThan(sized.fit);
    expect(styledSibling?.position[1]).toBeLessThan(baseSibling?.position[1] ?? 0);
    expect((styledTitle?.fontSize ?? 0) / styled.fit).toBeCloseTo(
      (baseTitle?.fontSize ?? 0) / base.fit,
      12,
    );
    expect(base.nodes[0].position[0]).toBe(region.left);
  });

  it("preserves keyed offsets as local renderer nudges outside sibling flow", () => {
    const region = { left: 1.2, top: 1.1, bottom: -1.1, width: 1.4, align: "left" as const };
    const base = resolveManagedTextRenderPlan(doc, landscape, 1.25, region);
    const withNudge = resolveManagedTextRenderPlan(
      { ...doc, textStyle: { "title-aOffsetX": 1, "title-aOffsetY": -1 } },
      landscape,
      1.25,
      region,
    );

    expect(withNudge).toEqual(base);
  });

  it("gives blank items zero geometry and inserts gaps only between visible items", () => {
    const visible: SceneDoc = {
      version: 1,
      managedText: { items: [{ key: "live", type: "title", text: "Visible" }] },
    };
    const withBlanks: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "blank-title", type: "title", text: "" },
          { key: "blank-subtitle", type: "subtitle", text: "  " },
          { key: "blank-icon", type: "icon", icon: "" },
          { key: "blank-points", type: "bullets", points: [{ key: "p1", text: "" }] },
          { key: "live", type: "title", text: "Visible" },
        ],
      },
    };

    expect(resolveManagedTextRenderPlan(withBlanks, landscape, 1.25)).toEqual(
      resolveManagedTextRenderPlan(visible, landscape, 1.25),
    );
  });
});
