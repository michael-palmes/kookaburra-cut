import { afterEach, describe, expect, it } from "vitest";
import type { InspectorState } from "../../store/uiStore";
import {
  clickInspectorRemoveAction,
  contentDeleteRoute,
  INSPECTOR_REMOVE_ACTION_SELECTOR,
} from "./contentDeleteKey";

const inspector = (patch: Partial<InspectorState> = {}): InspectorState => ({
  tab: "scene",
  drillStack: [],
  drillIn: null,
  overviewSelection: null,
  ...patch,
});

const selection = { sceneIndex: 0, rowId: "device:d1", domain: "devices" as const };

const sceneTabSource = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process
  .getBuiltinModule("fs")
  .readFileSync(new URL("./SceneTab.tsx", import.meta.url), "utf8");

describe("contentDeleteRoute", () => {
  it("stands down outside the Scene tab", () => {
    expect(
      contentDeleteRoute(inspector({ tab: "project", overviewSelection: selection })),
    ).toBeNull();
    expect(
      contentDeleteRoute(inspector({ tab: "project", drillStack: ["device"], drillIn: "device" })),
    ).toBeNull();
  });

  it("takes the overview route only while a row is selected", () => {
    expect(contentDeleteRoute(inspector())).toBeNull();
    expect(contentDeleteRoute(inspector({ overviewSelection: selection }))).toBe("overview");
  });

  it("takes the overview route for rows with no gizmo domain", () => {
    const comparison = { sceneIndex: 2, rowId: "comparison", domain: null };
    expect(contentDeleteRoute(inspector({ overviewSelection: comparison }))).toBe("overview");
  });

  it("leaves a selected decoration to DecorationGizmo, which binds Delete itself", () => {
    const decoration = { sceneIndex: 0, rowId: "image:dec-1", domain: "decorations" as const };
    expect(contentDeleteRoute(inspector({ overviewSelection: decoration }))).toBeNull();
  });

  it("takes the drill route for the content families whose header carries a trash", () => {
    for (const drillStack of [
      ["device"],
      ["device", "style.shadow"],
      ["image.edit"],
      ["objects.placement"],
      ["chart.edit"],
      ["text"],
    ]) {
      expect(
        contentDeleteRoute(inspector({ drillStack, drillIn: drillStack.at(-1) ?? null })),
      ).toBe("drill");
    }
  });

  it("leaves the decoration, singleton and non-content drills alone", () => {
    for (const drillStack of [
      ["legacyImage.edit"],
      ["frame.decorations"],
      ["compare.edit"],
      ["videoWindow.edit"],
      ["layeredScreenshot.edit"],
      ["camera"],
      ["motion.transition"],
    ]) {
      expect(
        contentDeleteRoute(inspector({ drillStack, drillIn: drillStack.at(-1) ?? null })),
      ).toBeNull();
    }
  });
});

// The repo tests in node, so the header trash is stubbed: the selector itself is pinned separately.
const stubDocument = (button: { disabled: boolean; click: () => void } | null) => {
  const queried: string[] = [];
  (globalThis as { document?: unknown }).document = {
    querySelector: (selector: string) => {
      queried.push(selector);
      return button;
    },
  };
  return queried;
};

describe("the Scene tab's Delete key", () => {
  it("stands down while typing, behind a modal, on a live lane and during export", () => {
    expect(sceneTabSource).toContain("isEditableTextTarget(e.target as HTMLElement | null)");
    expect(sceneTabSource).toContain(
      "isExporting() || modalOwnsKeyboard() || laneSelectionActive()",
    );
  });

  it("routes to the row menu's own delete path, never a parallel one", () => {
    expect(sceneTabSource).toContain('applyCurrentContentPlan(row, "delete", project.id');
    expect(sceneTabSource).toContain('{ type: "remove-group", groupKey: row.selectionTarget.id }');
  });

  it("routes the text drill to the selected element before the group trash", () => {
    expect(sceneTabSource).toContain('gizmoDomainForDrillStack(inspector.drillStack) === "text"');
    expect(sceneTabSource).toContain("deleteSelectedTextItemRef.current?.()");
  });
});

describe("clickInspectorRemoveAction", () => {
  afterEach(() => {
    (globalThis as { document?: unknown }).document = undefined;
  });

  it("reaches the live drill page only, never the outgoing ghost snapshot", () => {
    expect(INSPECTOR_REMOVE_ACTION_SELECTOR).toBe(
      ".inspector-nav-shell > .inspector-nav-page .inspector-drill-header-action.danger",
    );
  });

  it("clicks the header trash and reports it", () => {
    let clicks = 0;
    const queried = stubDocument({ disabled: false, click: () => clicks++ });
    expect(clickInspectorRemoveAction()).toBe(true);
    expect(clicks).toBe(1);
    expect(queried).toEqual([INSPECTOR_REMOVE_ACTION_SELECTOR]);
  });

  it("reports nothing clicked when the header has no trash or it is mid-write", () => {
    stubDocument(null);
    expect(clickInspectorRemoveAction()).toBe(false);
    let clicks = 0;
    stubDocument({ disabled: true, click: () => clicks++ });
    expect(clickInspectorRemoveAction()).toBe(false);
    expect(clicks).toBe(0);
  });
});
