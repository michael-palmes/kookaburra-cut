import { describe, expect, it, vi } from "vitest";
import { bindHistory, pushHistory, takeRedo, takeUndo } from "../../engine/history";
import type { VirtualManagedTextRegistration } from "../../engine/managedText";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { FrameSpec } from "../../toolkit/frame/types";
import {
  applyManagedTextStructuralAction,
  describeManagedTextMotion,
  managedFrameIconValue,
  managedTextAlignment,
  managedTextGroupAlignment,
  managedTextStyleValue,
  managedTextVirtualOptionsForFrame,
  nextManagedTextKey,
  performManagedTextStructuralAction,
  rebaseTextMotionSpec,
  setLegacyManagedTextIcon,
  setManagedFrameIcon,
  setManagedTextAlignment,
  setManagedTextColour,
  setManagedTextCopy,
  setManagedTextGroupAlignment,
  setManagedTextIcon,
  setManagedTextPointCopy,
  setManagedTextStyle,
  setTextMotionSpec,
  textMotionSpec,
} from "./managedTextEditorModel";

const registrations: VirtualManagedTextRegistration[] = [
  {
    key: "title",
    text: "Code title",
    type: "title",
    style: { size: 1.15, offsetX: 0.2 },
    motion: { in: "fade-up", out: "none", staggerMs: 80 },
  },
  {
    key: "points",
    text: "First\nSecond",
    type: "bullets",
    points: [
      { key: "points-point-1", text: "First" },
      { key: "points-point-2", text: "Second" },
    ],
  },
];

describe("managed text editor model", () => {
  it("projects only frame icons that claim scene text", () => {
    const frame = { icon: "🚀" } as FrameSpec;
    expect(managedTextVirtualOptionsForFrame(frame)).toEqual({
      icon: "🚀",
      iconKey: "frameIcon",
      reserveLegacyFrameIcon: true,
    });
    expect(managedTextVirtualOptionsForFrame({} as FrameSpec)).toEqual({
      icon: "",
      iconKey: "frameIcon",
      reserveLegacyFrameIcon: true,
    });
    expect(managedTextVirtualOptionsForFrame({ ...frame, claimsSceneText: false })).toEqual({});
    expect(managedTextVirtualOptionsForFrame({ ...frame, enabled: false })).toEqual({});
  });

  it("writes alignment to the frame only while that frame claims scene text", () => {
    const doc: SceneDoc = { version: 1, textLayout: { align: "left" } };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      textAlign: "right",
    };

    expect(managedTextAlignment(doc)).toBe("left");
    expect(setManagedTextAlignment(doc, "center")).toMatchObject({
      textLayout: { align: "center" },
    });
    expect(managedTextAlignment(doc, frame)).toBe("right");
    expect(setManagedTextAlignment(doc, "left", frame)).toMatchObject({
      textLayout: { align: "left" },
      frame: { textAlign: "left" },
    });

    const unclaimed = { ...frame, claimsSceneText: false };
    expect(managedTextAlignment(doc, unclaimed)).toBe("left");
    expect(setManagedTextAlignment(doc, "right", unclaimed)).toMatchObject({
      textLayout: { align: "right" },
    });
  });

  it("moves a template layout to the generic stack when alignment changes", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "title", type: "title", text: "Specialised title" }],
      },
    };

    expect(setManagedTextAlignment(doc, "left")?.managedText).toEqual({
      items: [{ key: "title", type: "title", text: "Specialised title" }],
    });
    expect(doc.managedText?.layout).toBe("template");
  });

  it("reserves a later claiming frame without consuming the template icon on alignment", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "🪄" },
          { key: "title", type: "title", text: "Specialised title" },
        ],
      },
      textStyle: { iconSize: 1.4 },
    };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/frame.png",
      textAlign: "right",
    };

    const aligned = setManagedTextAlignment(doc, "left", frame);
    expect(aligned?.managedText).toEqual({
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
        { key: "icon", type: "icon", icon: "🪄" },
        { key: "title", type: "title", text: "Specialised title" },
      ],
    });
    expect(aligned?.textStyle).toEqual({ iconSize: 1.4 });
  });

  it("routes frame and scene icon writes to their separate legacy sources", () => {
    const doc: SceneDoc = {
      version: 1,
      headerIcon: "🚀",
      frame: { icon: "assets/scene-frame.png" },
    };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/resolved-frame.png",
    };

    const frameWrite = setLegacyManagedTextIcon(doc, "frameIcon", "✨", frame);
    expect(frameWrite?.frame?.icon).toBe("✨");
    expect(frameWrite?.headerIcon).toBe("🚀");

    const headerWrite = setLegacyManagedTextIcon(doc, "icon", "✨", {
      ...frame,
    });
    expect(headerWrite?.headerIcon).toBe("✨");
    expect(headerWrite?.frame?.icon).toBe("assets/scene-frame.png");
  });

  it("keeps reserved panel chrome outside groups while making it editable", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        groups: [{ key: "text", itemKeys: ["title"] }],
        items: [{ key: "title", type: "title", text: "Text" }],
      },
    };

    const added = setManagedFrameIcon(doc, "🚀", {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
    });
    expect(added?.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["title"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "🚀" },
        { key: "title", type: "title", text: "Text" },
      ],
    });
    expect(
      setManagedFrameIcon(added ?? doc, "", {
        cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      })?.managedText?.items[0],
    ).toEqual({
      key: "frameIcon",
      type: "icon",
      icon: "",
    });
    expect(
      setManagedFrameIcon(doc, "✨", {
        cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
        claimsSceneText: false,
        icon: "🚀",
      })?.frame?.icon,
    ).toBe("✨");

    const unclaimedFrame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "🖼️",
      claimsSceneText: false,
    };
    const unclaimed: SceneDoc = {
      ...doc,
      frame: unclaimedFrame,
      managedText: {
        ...doc.managedText,
        items: [
          { key: "frameIcon", type: "icon", icon: "stale" },
          ...(doc.managedText?.items ?? []),
        ],
      },
    };
    expect(managedFrameIconValue(unclaimed, unclaimedFrame)).toBe("🖼️");
    expect(setManagedFrameIcon(unclaimed, "🌿", unclaimedFrame)?.frame?.icon).toBe("🌿");
    expect(
      setManagedFrameIcon({ version: 1, frame: unclaimedFrame }, "🌿", unclaimedFrame)?.frame?.icon,
    ).toBe("🌿");
  });

  it("migrates matching legacy panel chrome with its style and motion before editing", () => {
    const motion = { in: "fade-up", out: "none", staggerMs: 20 } as const;
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "icon", type: "icon", icon: "assets/legacy-frame.png" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
      textStyle: { iconSize: 1.4, iconOffsetX: 0.2, titleSize: 1.1 },
      textAnimationOverrides: { icon: motion },
    };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/legacy-frame.png",
    };

    const edited = setManagedFrameIcon(doc, "🚀", frame);
    expect(edited?.managedText?.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "🚀" },
      { key: "title", type: "title", text: "Launch" },
    ]);
    expect(edited?.managedText?.layout).toBe("template");
    expect(edited?.textStyle).toEqual({
      frameIconSize: 1.4,
      frameIconOffsetX: 0.2,
      titleSize: 1.1,
    });
    expect(edited?.textAnimationOverrides).toEqual({ frameIcon: motion });

    const cleared = setManagedFrameIcon(edited ?? doc, "", { ...frame, icon: "🚀" });
    expect(cleared?.managedText?.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "" },
      { key: "title", type: "title", text: "Launch" },
    ]);
    expect(doc.managedText?.items[0]).toEqual({
      key: "icon",
      type: "icon",
      icon: "assets/legacy-frame.png",
    });
  });

  it("keeps a template content icon separate when a claiming frame is applied later", () => {
    const motion = { in: "fade", out: "none", staggerMs: 20 } as const;
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        groups: [{ key: "text", itemKeys: ["icon", "title"] }],
        items: [
          { key: "icon", type: "icon", icon: "🪄" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
      textStyle: { iconSize: 1.4 },
      textAnimationOverrides: { icon: motion },
    };
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/frame.png",
    };

    expect(managedFrameIconValue(doc, frame)).toBe("assets/frame.png");
    const edited = setManagedFrameIcon(doc, "🚀", frame);
    expect(edited?.managedText).toEqual({
      layout: "template",
      groups: [{ key: "text", itemKeys: ["icon", "title"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "🚀" },
        { key: "icon", type: "icon", icon: "🪄" },
        { key: "title", type: "title", text: "Launch" },
      ],
    });
    expect(edited?.textStyle).toEqual({ iconSize: 1.4 });
    expect(edited?.textAnimationOverrides).toEqual({ icon: motion });
  });

  it("keeps dual-icon templates and generic grouped icons independent", () => {
    const frame: FrameSpec = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
    };
    const dual: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
          { key: "icon", type: "icon", icon: "🪄" },
        ],
      },
    };
    expect(setManagedFrameIcon(dual, "🚀", frame)?.managedText?.items).toEqual([
      { key: "frameIcon", type: "icon", icon: "🚀" },
      { key: "icon", type: "icon", icon: "🪄" },
    ]);

    const generic: SceneDoc = {
      version: 1,
      managedText: {
        groups: [{ key: "text", itemKeys: ["icon", "title"] }],
        items: [
          { key: "icon", type: "icon", icon: "🪄" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
    };
    expect(setManagedFrameIcon(generic, "🚀", frame)?.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["icon", "title"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "🚀" },
        { key: "icon", type: "icon", icon: "🪄" },
        { key: "title", type: "title", text: "Launch" },
      ],
    });
  });

  it("reserves legacy panel chrome during a structural text edit", () => {
    const motion = { in: "fade", out: "none", staggerMs: 20 } as const;
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
      textStyle: { iconSize: 1.4, titleSize: 1.1 },
      textAnimationOverrides: { icon: motion },
    };

    const result = applyManagedTextStructuralAction(
      doc,
      {
        type: "add-item",
        itemType: "subtitle",
        groupKey: "text",
      },
      [],
      managedTextVirtualOptionsForFrame({
        cutout: { shape: "none" },
        icon: "assets/legacy-frame.png",
      }),
    );
    expect(result?.selectedItemKey).toBe("subtitle");
    expect(result?.doc.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["title", "subtitle"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/legacy-frame.png" },
        { key: "title", type: "title", text: "Launch" },
        { key: "subtitle", type: "subtitle", text: "Text" },
      ],
    });
    expect(result?.doc.textStyle).toEqual({ frameIconSize: 1.4, titleSize: 1.1 });
    expect(result?.doc.textAnimationOverrides).toEqual({ frameIcon: motion });

    const aligned = setManagedTextGroupAlignment(
      doc,
      "text",
      "right",
      managedTextVirtualOptionsForFrame({
        cutout: { shape: "none" },
        icon: "assets/legacy-frame.png",
      }),
    );
    expect(aligned?.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["title"], align: "right" }],
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/legacy-frame.png" },
        { key: "title", type: "title", text: "Launch" },
      ],
    });
    expect(aligned?.textStyle).toEqual({ frameIconSize: 1.4, titleSize: 1.1 });
    expect(aligned?.textAnimationOverrides).toEqual({ frameIcon: motion });
    expect(doc.managedText?.items[0]?.key).toBe("icon");
  });

  it("preserves a template scene icon through structural and alignment edits after framing", () => {
    const motion = { in: "fade", out: "none", staggerMs: 20 } as const;
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        groups: [{ key: "text", itemKeys: ["icon", "title"] }],
        items: [
          { key: "icon", type: "icon", icon: "🪄" },
          { key: "title", type: "title", text: "Launch" },
        ],
      },
      textStyle: { iconSize: 1.4 },
      textAnimationOverrides: { icon: motion },
    };
    const options = managedTextVirtualOptionsForFrame({
      cutout: { shape: "none" },
      icon: "assets/frame.png",
    });

    const result = applyManagedTextStructuralAction(
      doc,
      {
        type: "add-item",
        itemType: "subtitle",
        groupKey: "text",
      },
      [],
      options,
    );
    expect(result?.doc.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["icon", "title", "subtitle"] }],
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
        { key: "icon", type: "icon", icon: "🪄" },
        { key: "title", type: "title", text: "Launch" },
        { key: "subtitle", type: "subtitle", text: "Text" },
      ],
    });
    expect(result?.doc.textStyle).toEqual({ iconSize: 1.4 });
    expect(result?.doc.textAnimationOverrides).toEqual({ icon: motion });

    const aligned = setManagedTextGroupAlignment(doc, "text", "right", options);
    expect(aligned?.managedText).toEqual({
      groups: [{ key: "text", itemKeys: ["icon", "title"], align: "right" }],
      items: [
        { key: "frameIcon", type: "icon", icon: "assets/frame.png" },
        { key: "icon", type: "icon", icon: "🪄" },
        { key: "title", type: "title", text: "Launch" },
      ],
    });
    expect(aligned?.textStyle).toEqual({ iconSize: 1.4 });
    expect(aligned?.textAnimationOverrides).toEqual({ icon: motion });
  });

  it("mints stable readable keys without collisions", () => {
    expect(nextManagedTextKey("title", [])).toBe("title");
    expect(nextManagedTextKey("title", ["title", "title-2", "title-4"])).toBe("title-3");
  });

  it("projects a legacy flat block as one group and writes its independent alignment", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Title" },
          { key: "subtitle", type: "subtitle", text: "Subtitle" },
        ],
      },
      textLayout: { align: "left" },
    };

    expect(managedTextGroupAlignment(doc, "text")).toBe("left");
    expect(setManagedTextGroupAlignment(doc, "text", "right")?.managedText).toEqual({
      items: doc.managedText?.items,
      groups: [{ key: "text", itemKeys: ["title", "subtitle"], align: "right" }],
    });
    expect(doc.managedText?.groups).toBeUndefined();
  });

  it("preserves explicit groups when a group edit leaves template layout", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "title", type: "title", text: "Title" }],
        groups: [{ key: "text", itemKeys: ["title"] }],
      },
    };

    expect(setManagedTextGroupAlignment(doc, "text", "right")?.managedText).toEqual({
      items: doc.managedText?.items,
      groups: [{ key: "text", itemKeys: ["title"], align: "right" }],
    });
  });

  it("materialises legacy bullet copy before leaving template layout", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [{ key: "bullets", type: "bullets", text: "First\nSecond" }],
      },
    };

    expect(setManagedTextGroupAlignment(doc, "text", "right")?.managedText).toEqual({
      items: [
        {
          key: "bullets",
          type: "bullets",
          text: "First\nSecond",
          points: [
            { key: "bullets-point-1", text: "First" },
            { key: "bullets-point-2", text: "Second" },
          ],
        },
      ],
      groups: [{ key: "text", itemKeys: ["bullets"], align: "right" }],
    });
    expect(doc.managedText?.items[0]).not.toHaveProperty("points");
  });

  it("adds a Title-only Text group and preserves a legacy flat block as one group", () => {
    const empty = applyManagedTextStructuralAction(
      { version: 1, managedText: { items: [] } },
      { type: "add-group" },
    );
    expect(empty).toMatchObject({
      selectedGroupKey: "text",
      selectedItemKey: "title",
      doc: {
        managedText: {
          items: [{ key: "title", type: "title", text: "Text" }],
          groups: [{ key: "text", itemKeys: ["title"] }],
        },
      },
    });

    const legacy: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Existing" },
          { key: "subtitle", type: "subtitle", text: "Copy" },
        ],
      },
    };
    const added = applyManagedTextStructuralAction(legacy, { type: "add-group" });
    expect(added?.selectedGroupKey).toBe("text-2");
    expect(added?.doc.managedText?.groups).toEqual([
      { key: "text", itemKeys: ["title", "subtitle"] },
      { key: "text-2", itemKeys: ["title-2"] },
    ]);
    expect(added?.doc.managedText?.items.at(-1)).toEqual({
      key: "title-2",
      type: "title",
      text: "Text",
    });
    expect(legacy.managedText?.groups).toBeUndefined();
  });

  it("adds multiple leaves of every copy type within one group", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [],
        groups: [{ key: "text", itemKeys: [] }],
      },
    };
    const result = (["icon", "title", "subtitle", "bullets"] as const).reduce(
      (current, itemType) => {
        const first = applyManagedTextStructuralAction(current, {
          type: "add-item",
          groupKey: "text",
          itemType,
        });
        const second = applyManagedTextStructuralAction(first?.doc ?? current, {
          type: "add-item",
          groupKey: "text",
          itemType,
        });
        if (!second) throw new Error(`expected a second ${itemType} item`);
        return second.doc;
      },
      doc,
    );

    expect(result.managedText?.items.map((item) => item.key)).toEqual([
      "icon",
      "icon-2",
      "title",
      "title-2",
      "subtitle",
      "subtitle-2",
      "bullets",
      "bullets-2",
    ]);
    expect(result.managedText?.groups?.[0]?.itemKeys).toEqual([
      "icon",
      "icon-2",
      "title",
      "title-2",
      "subtitle",
      "subtitle-2",
      "bullets",
      "bullets-2",
    ]);
    expect(
      applyManagedTextStructuralAction(result, {
        type: "change-type",
        itemKey: "subtitle",
        itemType: "title",
      })?.doc.managedText?.items.find((item) => item.key === "subtitle")?.type,
    ).toBe("title");

    const removed = applyManagedTextStructuralAction(result, {
      type: "remove-item",
      itemKey: "subtitle-2",
    });
    expect(removed?.selectedGroupKey).toBe("text");
    expect(removed?.doc.managedText?.items.some((item) => item.key === "subtitle")).toBe(true);
    expect(removed?.doc.managedText?.items.some((item) => item.key === "subtitle-2")).toBe(false);
    expect(removed?.doc.managedText?.groups?.[0]?.itemKeys).not.toContain("subtitle-2");
  });

  it.each([
    ["title", { key: "title", type: "title", text: "Text" }],
    ["subtitle", { key: "subtitle", type: "subtitle", text: "Text" }],
    ["icon", { key: "icon", type: "icon", icon: "🚀" }],
    [
      "bullets",
      {
        key: "bullets",
        type: "bullets",
        points: [{ key: "bullets-point-1", text: "Text" }],
      },
    ],
  ] as const)("adds visible placeholder copy for a new %s item", (itemType, expected) => {
    const result = applyManagedTextStructuralAction(
      { version: 1, managedText: { items: [] } },
      { type: "add-item", itemType },
    );

    expect(result?.selectedItemKey).toBe(itemType);
    expect(result?.doc.managedText?.items).toEqual([expected]);
  });

  it("cancels code-owned structural edits without writing", async () => {
    const commit = vi.fn();
    const confirmTakeover = vi.fn(async () => false);

    const status = await performManagedTextStructuralAction({
      doc: { version: 1 },
      registrations,
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      confirmTakeover,
      commit,
    });

    expect(status).toBe("cancelled");
    expect(confirmTakeover).toHaveBeenCalledWith({
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      itemCount: 2,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("materialises the virtual sheet and triggering action in one accepted write", async () => {
    const original: SceneDoc = { version: 1, text: { subtitle: "Sidecar subtitle" } };
    const commit = vi.fn();

    const status = await performManagedTextStructuralAction({
      doc: original,
      registrations,
      action: { type: "add-item", itemType: "subtitle", afterKey: "title" },
      confirmTakeover: async () => true,
      commit,
    });

    expect(status).toBe("committed");
    expect(commit).toHaveBeenCalledTimes(1);
    const [result, history] = commit.mock.calls[0] ?? [];
    expect(history).toBe("add text line");
    expect(result.selectedItemKey).toBe("subtitle-2");
    expect(result.doc.managedText?.items).toEqual([
      expect.objectContaining({ key: "title", text: "Code title" }),
      { key: "subtitle-2", type: "subtitle", text: "Text" },
      expect.objectContaining({ key: "points" }),
      expect.objectContaining({ key: "subtitle", text: "Sidecar subtitle" }),
    ]);
    expect(result.doc.textStyle).toMatchObject({ titleSize: 1.15, titleOffsetX: 0.2 });
    expect(result.doc.textAnimationOverrides?.title?.in).toBe("fade-up");
    expect(original.managedText).toBeUndefined();
  });

  it("records one takeover edge whose Undo restores code ownership and Redo restores the overlay projection", async () => {
    const original: SceneDoc = {
      version: 1,
      text: { title: "Code title" },
      textLayout: { align: "right" },
    };
    const frame = {
      cutout: { shape: "rounded-rect", side: "end", size: 0.34 },
      icon: "assets/frame-mark.png",
    } as FrameSpec;
    bindHistory(null);
    bindHistory("ws:managed-text-takeover");
    try {
      const status = await performManagedTextStructuralAction({
        doc: original,
        registrations: registrations.slice(0, 1),
        virtualOptions: managedTextVirtualOptionsForFrame(frame),
        action: { type: "take-over", itemKey: "frameIcon" },
        confirmTakeover: async () => true,
        commit: (result, history) => {
          pushHistory({
            label: history,
            changes: [
              {
                kind: "sceneDoc",
                slug: "managed-text-takeover",
                file: "scenes/01-lockup.tsx",
                sceneIndex: 0,
                before: original,
                after: result.doc,
              },
            ],
          });
        },
      });

      expect(status).toBe("committed");
      const undo = takeUndo();
      expect(undo?.label).toBe("take over scene text");
      const undoChange = undo?.changes[0];
      expect(undoChange?.kind).toBe("sceneDoc");
      if (undoChange?.kind !== "sceneDoc") throw new Error("missing Undo edge");
      expect(undoChange.before).toEqual(original);
      expect(undoChange.before?.managedText).toBeUndefined();

      const redo = takeRedo();
      const redoChange = redo?.changes[0];
      expect(redoChange?.kind).toBe("sceneDoc");
      if (redoChange?.kind !== "sceneDoc") throw new Error("missing Redo edge");
      expect(redoChange.after?.managedText?.items).toEqual([
        { key: "frameIcon", type: "icon", icon: "assets/frame-mark.png" },
        { key: "title", type: "title", text: "Code title" },
      ]);
    } finally {
      bindHistory(null);
    }
  });

  it("materialises a code-owned icon before exposing controls with no legacy write path", async () => {
    const iconRegistration: VirtualManagedTextRegistration[] = [
      {
        key: "brand-icon",
        text: "",
        type: "icon",
        icon: "assets/app-icon.png",
        style: { size: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
      },
    ];
    const commit = vi.fn();

    const status = await performManagedTextStructuralAction({
      doc: { version: 1 },
      registrations: iconRegistration,
      action: { type: "take-over", itemKey: "brand-icon" },
      confirmTakeover: async () => true,
      commit,
    });

    expect(status).toBe("committed");
    expect(commit).toHaveBeenCalledWith(
      {
        doc: expect.objectContaining({
          managedText: {
            items: [
              {
                key: "brand-icon",
                type: "icon",
                text: "",
                icon: "assets/app-icon.png",
              },
            ],
          },
        }),
        selectedItemKey: "brand-icon",
        selectedGroupKey: "text",
      },
      "take over scene text",
    );
  });

  it("does not prompt after ownership has transferred", async () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: { items: [{ key: "title", type: "title", text: "Hello" }] },
    };
    const confirmTakeover = vi.fn(async () => false);
    const commit = vi.fn();

    expect(
      await performManagedTextStructuralAction({
        doc,
        action: { type: "change-type", itemKey: "title", itemType: "subtitle" },
        confirmTakeover,
        commit,
      }),
    ).toBe("committed");
    expect(confirmTakeover).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: "add-item", itemType: "subtitle" } as const,
    { type: "duplicate-item", itemKey: "title" } as const,
    { type: "remove-item", itemKey: "subtitle" } as const,
    { type: "move-item", itemKey: "title", toIndex: 1 } as const,
    { type: "change-type", itemKey: "title", itemType: "subtitle" } as const,
    { type: "add-point", itemKey: "bullets", text: "Three" } as const,
    { type: "remove-point", itemKey: "bullets", pointKey: "bullets-point-1" } as const,
    { type: "move-point", itemKey: "bullets", pointKey: "bullets-point-1", toIndex: 1 } as const,
    { type: "set-marker", itemKey: "bullets", marker: "tick" } as const,
    { type: "set-point-gap", itemKey: "bullets", pointGap: 0.2 } as const,
    { type: "set-indent", itemKey: "bullets", indent: 0.3 } as const,
  ])("moves a template layout to the generic stack for $type", (action) => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Title" },
          { key: "subtitle", type: "subtitle", text: "Subtitle" },
          {
            key: "bullets",
            type: "bullets",
            marker: "dot",
            pointGap: 0.1,
            indent: 0.1,
            points: [
              { key: "bullets-point-1", text: "One" },
              { key: "bullets-point-2", text: "Two" },
            ],
          },
        ],
      },
    };

    const result = applyManagedTextStructuralAction(doc, action);

    expect(result?.doc.managedText?.layout).toBeUndefined();
    expect(doc.managedText?.layout).toBe("template");
  });

  it("keeps a template layout for copy, style, icon and motion edits", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        layout: "template",
        items: [
          { key: "title", type: "title", text: "Title" },
          { key: "icon", type: "icon", icon: "🚀" },
        ],
      },
    };

    const copy = setManagedTextCopy(doc, "title", "Edited");
    const style = setManagedTextStyle(copy ?? doc, "title", "size", 1.2);
    const icon = setManagedTextIcon(style ?? doc, "icon", "✨");
    const motion = setTextMotionSpec(
      icon ?? doc,
      { kind: "all" },
      {
        in: "fade-up",
        out: "none",
        staggerMs: 0,
      },
    );

    expect(copy?.managedText?.layout).toBe("template");
    expect(style?.managedText?.layout).toBe("template");
    expect(icon?.managedText?.layout).toBe("template");
    expect(motion.managedText?.layout).toBe("template");
  });

  it("duplicates one item atomically beside its source with keyed side tables", async () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "bullets",
            type: "bullets",
            text: "Dormant copy",
            icon: "✨",
            marker: "tick",
            pointGap: 0.18,
            indent: 0.24,
            points: [
              { key: "bullets-point-1", text: "One" },
              { key: "bullets-point-2", text: "Two" },
            ],
          },
        ],
        groups: [{ key: "text", itemKeys: ["bullets"] }],
      },
      textStyle: { bulletsSize: 1.2, bulletsOffsetY: -0.3 },
      textAnimationOverrides: {
        bullets: { in: "fade", out: "none", staggerMs: 0 },
      },
    };

    const commit = vi.fn();
    const status = await performManagedTextStructuralAction({
      doc,
      action: { type: "duplicate-item", itemKey: "bullets" },
      commit,
    });
    const [result, history] = commit.mock.calls[0] ?? [];

    expect(status).toBe("committed");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(history).toBe("duplicate text line");
    expect(result.selectedGroupKey).toBe("text");
    expect(result.selectedItemKey).toBe("bullets-2");
    expect(result.doc.managedText?.groups?.[0]?.itemKeys).toEqual(["bullets", "bullets-2"]);
    expect(result.doc.managedText?.items[1]).toEqual({
      ...doc.managedText?.items[0],
      key: "bullets-2",
      points: [
        { key: "bullets-2-point-1", text: "One" },
        { key: "bullets-2-point-2", text: "Two" },
      ],
    });
    expect(result.doc.textStyle).toMatchObject({
      "bullets-2Size": 1.2,
      "bullets-2OffsetY": -0.3,
    });
    expect(result.doc.textAnimationOverrides?.["bullets-2"]).toEqual(
      doc.textAnimationOverrides?.bullets,
    );
    expect(result.doc.textAnimationOverrides?.["bullets-2"]).not.toBe(
      doc.textAnimationOverrides?.bullets,
    );

    const removed = applyManagedTextStructuralAction(result.doc, {
      type: "remove-item",
      itemKey: "bullets-2",
    });
    expect(removed?.doc.managedText?.items.map((item) => item.key)).toEqual(["bullets"]);
    expect(removed?.doc.managedText?.groups?.[0]?.itemKeys).toEqual(["bullets"]);
    expect(removed?.doc.textStyle).toEqual(doc.textStyle);
    expect(removed?.doc.textAnimationOverrides).toEqual(doc.textAnimationOverrides);
  });

  it("selects the next group item after removal, otherwise the previous one", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "a", type: "title", text: "A" },
          { key: "other", type: "title", text: "Other group" },
          { key: "b", type: "subtitle", text: "B" },
          { key: "c", type: "title", text: "C" },
        ],
        groups: [
          { key: "text", itemKeys: ["a", "b", "c"] },
          { key: "text-2", itemKeys: ["other"] },
        ],
      },
    };

    const middle = applyManagedTextStructuralAction(doc, {
      type: "remove-item",
      itemKey: "b",
    });
    expect(middle?.selectedGroupKey).toBe("text");
    expect(middle?.selectedItemKey).toBe("c");
    expect(middle?.doc.managedText?.groups?.[0]?.itemKeys).toEqual(["a", "c"]);

    const final = applyManagedTextStructuralAction(doc, {
      type: "remove-item",
      itemKey: "c",
    });
    expect(final?.selectedGroupKey).toBe("text");
    expect(final?.selectedItemKey).toBe("b");
    expect(final?.doc.managedText?.groups?.[0]?.itemKeys).toEqual(["a", "b"]);
  });

  it("duplicates and removes a whole group with its leaf side tables", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Launch" },
          {
            key: "bullets",
            type: "bullets",
            points: [{ key: "bullets-point-1", text: "Fast" }],
          },
        ],
        groups: [{ key: "text", itemKeys: ["title", "bullets"], align: "right" }],
      },
      textStyle: { titleSize: 1.2 },
      textAnimationOverrides: {
        bullets: { in: "fade-up", out: "none", staggerMs: 40 },
      },
    };

    const duplicated = applyManagedTextStructuralAction(doc, {
      type: "duplicate-group",
      groupKey: "text",
    });
    expect(duplicated?.selectedGroupKey).toBe("text-2");
    expect(duplicated?.selectedItemKey).toBe("title-2");
    expect(duplicated?.doc.managedText?.groups).toEqual([
      { key: "text", itemKeys: ["title", "bullets"], align: "right" },
      { key: "text-2", itemKeys: ["title-2", "bullets-2"], align: "right" },
    ]);
    expect(duplicated?.doc.managedText?.items.slice(2)).toEqual([
      { key: "title-2", type: "title", text: "Launch" },
      {
        key: "bullets-2",
        type: "bullets",
        points: [{ key: "bullets-2-point-1", text: "Fast" }],
      },
    ]);
    expect(duplicated?.doc.textStyle?.["title-2Size"]).toBe(1.2);
    expect(duplicated?.doc.textAnimationOverrides?.["bullets-2"]?.in).toBe("fade-up");

    const removed = applyManagedTextStructuralAction(duplicated?.doc ?? doc, {
      type: "remove-group",
      groupKey: "text",
    });
    expect(removed?.selectedGroupKey).toBe("text-2");
    expect(removed?.doc.managedText?.groups).toEqual([
      { key: "text-2", itemKeys: ["title-2", "bullets-2"], align: "right" },
    ]);
    expect(removed?.doc.managedText?.items.map((item) => item.key)).toEqual([
      "title-2",
      "bullets-2",
    ]);
    expect(removed?.doc.textStyle?.titleSize).toBeUndefined();
    expect(removed?.doc.textAnimationOverrides?.bullets).toBeUndefined();
  });

  it("retains dormant fields across type changes", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "line",
            type: "bullets",
            text: "Fallback",
            icon: "assets/icon.png",
            points: [{ key: "line-point-1", text: "Point" }],
            marker: "dash",
          },
        ],
      },
    };

    const result = applyManagedTextStructuralAction(doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "icon",
    });

    expect(result?.doc.managedText?.items[0]).toEqual({
      ...doc.managedText?.items[0],
      type: "icon",
    });
  });

  it("seeds missing type content while preserving dormant copy", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "line", type: "title" },
          {
            key: "complete",
            type: "title",
            text: "Keep me",
            icon: "✨",
            points: [{ key: "complete-point-1", text: "Keep this point" }],
          },
        ],
        groups: [{ key: "text", itemKeys: ["line", "complete"] }],
      },
    };

    const icon = applyManagedTextStructuralAction(doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "icon",
    });
    expect(icon?.doc.managedText?.items[0]).toEqual({
      key: "line",
      type: "icon",
      icon: "🚀",
    });

    const bullets = applyManagedTextStructuralAction(icon?.doc ?? doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "bullets",
    });
    expect(bullets?.doc.managedText?.items[0]).toEqual({
      key: "line",
      type: "bullets",
      icon: "🚀",
      points: [{ key: "line-point-1", text: "Text" }],
    });

    const title = applyManagedTextStructuralAction(bullets?.doc ?? doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "title",
    });
    expect(title?.doc.managedText?.items[0]).toEqual({
      key: "line",
      type: "title",
      text: "Text",
      icon: "🚀",
      points: [{ key: "line-point-1", text: "Text" }],
    });

    const preserved = applyManagedTextStructuralAction(doc, {
      type: "change-type",
      itemKey: "complete",
      itemType: "bullets",
    });
    expect(preserved?.doc.managedText?.items[1]).toEqual({
      ...doc.managedText?.items[1],
      type: "bullets",
    });
  });

  it("keeps a cleared icon explicit through a round trip to its dormant title", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [{ key: "line", type: "title", text: "Headline" }],
        groups: [{ key: "text", itemKeys: ["line"] }],
      },
    };
    const icon = applyManagedTextStructuralAction(doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "icon",
    });
    expect(icon?.doc.managedText?.items[0]).toEqual({
      key: "line",
      type: "icon",
      text: "Headline",
      icon: "🚀",
    });

    const cleared = setManagedTextIcon(icon?.doc ?? doc, "line", undefined);
    expect(cleared?.managedText?.items[0]).toEqual({
      key: "line",
      type: "icon",
      text: "Headline",
      icon: "",
    });

    const title = applyManagedTextStructuralAction(cleared ?? doc, {
      type: "change-type",
      itemKey: "line",
      itemType: "title",
    });
    expect(title?.doc.managedText?.items[0]).toEqual({
      key: "line",
      type: "title",
      text: "Headline",
      icon: "",
    });
  });

  it.each(["icon", "bullets"] as const)(
    "seeds visible title copy when a new %s has no dormant text",
    (itemType) => {
      const added = applyManagedTextStructuralAction(
        { version: 1, managedText: { items: [] } },
        { type: "add-item", itemType },
      );
      const title = applyManagedTextStructuralAction(added?.doc ?? { version: 1 }, {
        type: "change-type",
        itemKey: itemType,
        itemType: "title",
      });

      expect(title?.doc.managedText?.items[0]?.text).toBe("Text");
    },
  );

  it("preserves deliberately blank dormant copy when switching to text", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [{ key: "line", type: "icon", icon: "🚀", text: "" }],
      },
    };

    expect(
      applyManagedTextStructuralAction(doc, {
        type: "change-type",
        itemKey: "line",
        itemType: "title",
      })?.doc.managedText?.items[0]?.text,
    ).toBe("");
  });

  it("reorders explicit group leaves and bullet points with stable keys and history", async () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Title" },
          { key: "subtitle", type: "subtitle", text: "Subtitle" },
          {
            key: "bullets",
            type: "bullets",
            points: [
              { key: "bullets-point-1", text: "One" },
              { key: "bullets-point-2", text: "Two" },
            ],
          },
        ],
        groups: [{ key: "text", itemKeys: ["title", "subtitle", "bullets"] }],
      },
    };
    const lineCommit = vi.fn();
    await performManagedTextStructuralAction({
      doc,
      action: { type: "move-item", itemKey: "title", toIndex: 1 },
      commit: lineCommit,
    });
    const [lineResult, lineHistory] = lineCommit.mock.calls[0] ?? [];
    expect(lineHistory).toBe("reorder text lines");
    expect(lineResult.doc.managedText?.items.map((item: { key: string }) => item.key)).toEqual([
      "subtitle",
      "title",
      "bullets",
    ]);
    expect(lineResult.doc.managedText?.groups?.[0]?.itemKeys).toEqual([
      "subtitle",
      "title",
      "bullets",
    ]);

    const pointCommit = vi.fn();
    await performManagedTextStructuralAction({
      doc,
      action: {
        type: "move-point",
        itemKey: "bullets",
        pointKey: "bullets-point-1",
        toIndex: 1,
      },
      commit: pointCommit,
    });
    const [pointResult, pointHistory] = pointCommit.mock.calls[0] ?? [];
    expect(pointHistory).toBe("reorder bullet points");
    expect(
      pointResult.doc.managedText?.items
        .find((item: { key: string }) => item.key === "bullets")
        ?.points?.map((point: { key: string }) => point.key),
    ).toEqual(["bullets-point-2", "bullets-point-1"]);
  });

  it("reorders from authoritative group order when flat item storage differs", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "frameIcon", type: "icon", icon: "🎨" },
          { key: "c", type: "bullets", points: [{ key: "c-point-1", text: "C" }] },
          { key: "b", type: "subtitle", text: "B" },
          { key: "a", type: "title", text: "A" },
        ],
        groups: [{ key: "text", itemKeys: ["a", "b", "c"] }],
      },
    };

    const result = applyManagedTextStructuralAction(doc, {
      type: "move-item",
      itemKey: "a",
      toIndex: 2,
    });

    expect(result?.selectedGroupKey).toBe("text");
    expect(result?.selectedItemKey).toBe("a");
    expect(result?.doc.managedText?.groups?.[0]?.itemKeys).toEqual(["b", "a", "c"]);
    expect(result?.doc.managedText?.items.map((item) => item.key)).toEqual([
      "frameIcon",
      "b",
      "a",
      "c",
    ]);
    expect(doc.managedText?.items.map((item) => item.key)).toEqual(["frameIcon", "c", "b", "a"]);
    expect(doc.managedText?.groups?.[0]?.itemKeys).toEqual(["a", "b", "c"]);
  });

  it("adds, reorders and removes bullet points without changing their keys", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          {
            key: "points",
            type: "bullets",
            points: [
              { key: "points-point-1", text: "One" },
              { key: "points-point-2", text: "Two" },
            ],
          },
        ],
      },
    };

    const added = applyManagedTextStructuralAction(doc, {
      type: "add-point",
      itemKey: "points",
      afterPointKey: "points-point-1",
      afterPointText: "One edited before Return",
      text: "Middle",
    });
    expect(added?.doc.managedText?.items[0]?.points).toEqual([
      { key: "points-point-1", text: "One edited before Return" },
      { key: "points-point-3", text: "Middle" },
      { key: "points-point-2", text: "Two" },
    ]);

    const moved = applyManagedTextStructuralAction(added?.doc ?? doc, {
      type: "move-point",
      itemKey: "points",
      pointKey: "points-point-2",
      toIndex: 0,
    });
    expect(moved?.doc.managedText?.items[0]?.points?.map((point) => point.key)).toEqual([
      "points-point-2",
      "points-point-1",
      "points-point-3",
    ]);

    const removed = applyManagedTextStructuralAction(moved?.doc ?? doc, {
      type: "remove-point",
      itemKey: "points",
      pointKey: "points-point-1",
    });
    expect(removed?.doc.managedText?.items[0]?.points?.map((point) => point.key)).toEqual([
      "points-point-2",
      "points-point-3",
    ]);
  });

  it("keeps copy and style edits on the authored path before takeover", () => {
    const doc: SceneDoc = { version: 1, headerIcon: "🚀" };

    const copy = setManagedTextCopy(doc, "title", "Edited", registrations);
    const point = setManagedTextPointCopy(
      copy ?? doc,
      "points",
      "points-point-2",
      "Changed",
      registrations,
    );
    const icon = setManagedTextIcon(point ?? doc, "icon", "✨", [], { icon: "🚀" });
    const styled = setManagedTextStyle(icon ?? doc, "title", "size", 1.25);

    expect(styled).toMatchObject({
      text: { title: "Edited", points: "First\nChanged" },
      headerIcon: "✨",
      textStyle: { titleSize: 1.25 },
    });
    expect(styled?.managedText).toBeUndefined();
    expect(managedTextStyleValue(styled ?? doc, "title", "size")).toBe(1.25);
    expect(managedTextStyleValue(styled ?? doc, "title", "rotation")).toBe(0);
  });

  it("sets and resets colour only for a current non-icon text item", () => {
    const doc: SceneDoc = {
      version: 1,
      managedText: {
        items: [
          { key: "title", type: "title", text: "Title" },
          { key: "icon", type: "icon", icon: "🚀" },
        ],
      },
      textStyle: { titleSize: 1.2 },
    };

    const coloured = setManagedTextColour(doc, "title", "#123456");
    expect(coloured?.textStyle).toEqual({ titleSize: 1.2, titleColor: "#123456" });
    expect(setManagedTextColour(coloured ?? doc, "title", "#123456")).toBeNull();
    expect(setManagedTextColour(coloured ?? doc, "icon", "#abcdef")).toBeNull();
    expect(setManagedTextColour(coloured ?? doc, "missing", "#abcdef")).toBeNull();

    const reset = setManagedTextColour(coloured ?? doc, "title", undefined);
    expect(reset?.textStyle).toEqual({ titleSize: 1.2 });
    expect(doc.textStyle).toEqual({ titleSize: 1.2 });
  });

  it("removes an empty colour style table and validates authored items", () => {
    const doc: SceneDoc = { version: 1, textStyle: { titleColor: "#123456" } };
    const reset = setManagedTextColour(doc, "title", undefined, registrations);

    expect(reset?.textStyle).toBeUndefined();
    expect(setManagedTextColour(doc, "missing", "#abcdef", registrations)).toBeNull();
  });

  it("writes all-lines motion independently from stable-key item exceptions", () => {
    const doc: SceneDoc = { version: 1 };
    const base = { in: "fade-up", out: "none", staggerMs: 90, durationMs: 500 };
    const exception = { in: "static", out: "static", staggerMs: 0 };

    const withBase = setTextMotionSpec(doc, { kind: "all" }, base);
    const withException = setTextMotionSpec(
      withBase,
      { kind: "item", itemKey: "title" },
      exception,
    );

    expect(textMotionSpec(withException, { kind: "all" })).toEqual(base);
    expect(textMotionSpec(withException, { kind: "item", itemKey: "title" })).toEqual(exception);
    expect(describeManagedTextMotion(exception)).toBe("None");
    expect(describeManagedTextMotion(undefined)).toBe("Theme");
    expect(describeManagedTextMotion(base)).toBe("Fade Up");

    const followsBase = setTextMotionSpec(
      withException,
      { kind: "item", itemKey: "title" },
      undefined,
    );
    expect(followsBase.textAnimationOverrides).toBeUndefined();
    expect(followsBase.textAnimation).toEqual(base);
  });

  it("rebases one motion-field change without dropping a queued sibling change", () => {
    const baseline = {
      in: "fade-up",
      out: "none",
      staggerMs: 90,
      durationMs: 500,
      ease: "outQuad",
    };
    const durationEdit = { ...baseline, durationMs: 900 };
    const queuedCurrent = { ...baseline, ease: "outExpo" };

    expect(rebaseTextMotionSpec(queuedCurrent, baseline, durationEdit)).toEqual({
      ...baseline,
      durationMs: 900,
      ease: "outExpo",
    });
  });
});
