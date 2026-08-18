import { describe, expect, it } from "vitest";
import { deriveSceneOverview } from "../inspectorOptions";

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const source = testProcess
  .getBuiltinModule("fs")
  .readFileSync(new URL("./SceneTab.tsx", import.meta.url), "utf8");

function sourceSection(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`SceneTab source section not found: ${start} to ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

function expectSuccessfulInspectorOpen({
  section,
  completion,
  selection,
  route,
}: {
  section: string;
  completion: string;
  selection: string;
  route: string;
}) {
  const completionIndex = section.indexOf(completion);
  const successGuardIndex = section.indexOf("!succeeded");
  const selectionIndex = section.indexOf(selection);
  const routeIndex = section.indexOf(route);

  expect(completionIndex).toBeGreaterThanOrEqual(0);
  expect(successGuardIndex).toBeGreaterThan(completionIndex);
  expect(selectionIndex).toBeGreaterThan(successGuardIndex);
  expect(routeIndex).toBeGreaterThan(selectionIndex);
}

describe("SceneTab Add Content inspector routing", () => {
  it("keeps WKWebView pointer focus changes inside the picker until click dispatch", () => {
    const boundary = sourceSection(
      '          className="inspector-scene-overview-content-head"',
      "          <SceneOverviewSectionHeader",
    );
    const outsidePointerEffect = sourceSection(
      "  useEffect(() => {\n    if (drillIn !== null || !contentPickerOpen) return;\n    const clearInternalPointer",
      "\n\n  // Re-list theme choices",
    );

    expect(boundary).toContain("onPointerDownCapture");
    expect(boundary).toContain("event.relatedTarget");
    expect(boundary).toContain("shouldCloseSceneOverviewPickerOnBlur");
    expect(boundary).not.toContain("requestAnimationFrame");
    expect(outsidePointerEffect).toContain('window.addEventListener("pointerup"');
    expect(outsidePointerEffect).toContain('window.addEventListener("pointercancel"');
    expect(outsidePointerEffect).toContain('window.removeEventListener("pointerup"');
    expect(outsidePointerEffect).toContain('window.removeEventListener("pointercancel"');
  });

  it("dispatches every overview add option to its creation flow", () => {
    const section = sourceSection(
      "  const addOverviewContent = (type: SceneOverviewContentType) => {",
      "  const overviewContentIcon = (type: SceneOverviewContentType): ReactNode => {",
    );
    const optionIds = deriveSceneOverview({
      doc: { version: 1 },
      durationMs: 4_000,
      slotsCount: 1,
    }).addOptions.map((option) => option.id);
    const dispatchedIds = [...section.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

    expect(dispatchedIds).toEqual(optionIds);
    expect(section).toMatch(/case "device":[\s\S]*?addDevice\(\);[\s\S]*?break;/);
    expect(section).toMatch(/case "text":[\s\S]*?addManagedTextOverviewItem\(\);[\s\S]*?break;/);
    expect(section).toMatch(
      /case "image":[\s\S]*?openMediaPicker\(\{ kind: "image" \}\);[\s\S]*?break;/,
    );
    expect(section).toMatch(/case "video":[\s\S]*?openDrill\("videoWindow\.edit"\);[\s\S]*?break;/);
    expect(section).toMatch(/case "object":[\s\S]*?openObjectPicker\(\);[\s\S]*?break;/);
    expect(section).toMatch(/case "chart":[\s\S]*?addChart\(\);[\s\S]*?break;/);
    expect(section).toMatch(
      /case "screenshotStack":[\s\S]*?openDrill\("layeredScreenshot\.edit"\);[\s\S]*?break;/,
    );
    expect(section).toMatch(/case "comparison":[\s\S]*?addCompare\(\);[\s\S]*?break;/);
  });

  it("opens each newly written item only after success and selection", () => {
    expectSuccessfulInspectorOpen({
      section: sourceSection(
        "  const addObjectFromPicker = (objectId: string) => {",
        "  /** Mutate the drill's staged object in place; a no-op when the scene has none. */",
      ),
      completion: "patchDocResult(",
      selection: "setPickedObjectId(id);",
      route: 'replaceDrill("objects.placement");',
    });
    expectSuccessfulInspectorOpen({
      section: sourceSection("  const addCompare = () => {", "  const addChart = () => {"),
      completion: "patchDocResult(",
      selection: 'setOverviewSelection({ sceneIndex: expectedSceneIndex, rowId: "comparison"',
      route: 'openDrill("compare.edit");',
    });
    expectSuccessfulInspectorOpen({
      section: sourceSection("  const addChart = () => {", "  const addChartSeries = () => {"),
      completion: "patchDocResult(",
      selection: "useChartEditStore.getState().select({ sceneIndex: expectedSceneIndex });",
      route: 'jumpDrill(["chart.edit"]);',
    });
    expectSuccessfulInspectorOpen({
      section: sourceSection(
        "  const addPickedImage = (src: string) => {",
        "  const pickSceneMedia = (rel: string, meta: MediaMeta | null) => {",
      ),
      completion: "patchDocResult(",
      selection:
        "useImageEditStore.getState().select({ sceneIndex: expectedSceneIndex, imageId: id });",
      route: 'jumpDrill(["image.edit"]);',
    });
    expectSuccessfulInspectorOpen({
      section: sourceSection(
        "  const addManagedTextOverviewItem = async () => {",
        "  const openContentMenu =",
      ),
      completion: "performManagedTextStructuralAction({",
      selection:
        "useTextEditStore.getState().select({ sceneIndex: expectedSceneIndex, key: selectedItemKey });",
      route: 'openDrill("text");',
    });
  });

  it("waits for the authoritative device document before opening its inspector", () => {
    const addSection = sourceSection(
      "  const addDevice = () => {",
      "  const duplicateSceneDevice =",
    );
    const pendingEffect = sourceSection(
      "  useEffect(() => {\n    if (!pendingDeviceInspectorOpen) return;",
      "\n\n  const openObjectPicker",
    );
    const completionIndex = addSection.indexOf("patchDocResult(");
    const pendingGuardIndex = addSection.indexOf("if (contentActionPendingRef.current) return;");
    const tokenIndex = addSection.indexOf('const actionToken = Symbol("add-device")');
    const acquireIndex = addSection.indexOf("contentActionPendingRef.current = {");
    const releaseIndex = addSection.lastIndexOf(
      "if (contentActionPendingRef.current?.token === actionToken)",
    );
    const successGuardIndex = addSection.indexOf("!succeeded");
    const selectionIndex = addSection.indexOf("pickDevice(id);");
    const overviewSelectionIndex = addSection.indexOf("setOverviewSelection({");
    const pendingIndex = addSection.indexOf("setPendingDeviceInspectorOpen({");
    const authoritativeIndex = pendingEffect.indexOf("doc?.devices?.some");
    const clearIndex = pendingEffect.lastIndexOf("setPendingDeviceInspectorOpen(null);");
    const openIndex = pendingEffect.indexOf('openDrill("device");');

    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(pendingGuardIndex).toBeGreaterThanOrEqual(0);
    expect(tokenIndex).toBeGreaterThan(pendingGuardIndex);
    expect(acquireIndex).toBeGreaterThan(tokenIndex);
    expect(completionIndex).toBeGreaterThan(acquireIndex);
    expect(releaseIndex).toBeGreaterThan(pendingIndex);
    expect(addSection).toContain("setContentActionBusy(true)");
    expect(addSection).toContain("setContentActionBusy(false)");
    expect(successGuardIndex).toBeGreaterThan(completionIndex);
    expect(selectionIndex).toBeGreaterThan(successGuardIndex);
    expect(overviewSelectionIndex).toBeGreaterThan(selectionIndex);
    expect(pendingIndex).toBeGreaterThan(overviewSelectionIndex);
    expect(addSection).not.toContain("requestAnimationFrame");
    expect(addSection).not.toContain('openDrill("device")');
    expect(pendingEffect).toContain("project.id === pendingDeviceInspectorOpen.projectId");
    expect(pendingEffect).toContain('currentUi.inspector.tab === "scene"');
    expect(pendingEffect).toContain("currentUi.inspectorNavigation.sequence ===");
    expect(authoritativeIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(authoritativeIndex);
    expect(openIndex).toBeGreaterThan(clearIndex);
  });

  it("does not let an old icon write close a re-opened child inspector", () => {
    const section = sourceSection(
      "  const textIconScreen = textIconInspectorScreenForRoute(drillIn);",
      '  if (drillIn === "text" && doc)',
    );
    const commitStart = section.indexOf("const commitIcon = async");
    const sequenceCapture = section.indexOf("const expectedNavigationSequence =", commitStart);
    const write = section.indexOf("await writeManagedText", commitStart);
    const sequenceGuard = section.indexOf(
      "inspectorNavigation.sequence !== expectedNavigationSequence",
      write,
    );
    const close = section.indexOf("closeDrill();", sequenceGuard);

    expect(sequenceCapture).toBeGreaterThan(commitStart);
    expect(write).toBeGreaterThan(sequenceCapture);
    expect(sequenceGuard).toBeGreaterThan(write);
    expect(close).toBeGreaterThan(sequenceGuard);
  });

  it("adds, duplicates and removes Text groups as atomic Content rows", () => {
    const addSection = sourceSection(
      "  const addManagedTextOverviewItem = async () => {",
      "  const openContentMenu =",
    );
    const contentSection = sourceSection(
      "  const applyManagedTextContentAction = async (",
      "  const addManagedTextOverviewItem = async () => {",
    );
    const menuSection = sourceSection(
      "  const openContentMenu = (row: SceneOverviewRowModel",
      "  const addOptionFor =",
    );

    expect(addSection).toContain('type: "add-group"');
    expect(addSection).toContain("afterKey: explicitlySelectedTextGroupKey");
    expect(addSection).toMatch(/const rowId = `text:\$\{selectedGroupKey\}`/);
    expect(contentSection).toContain('type: "duplicate-group" | "remove-group"');
    expect(menuSection).toContain('{ type: "duplicate-group", groupKey: row.selectionTarget.id }');
    expect(menuSection).toContain('{ type: "remove-group", groupKey: row.selectionTarget.id }');
  });

  it("appends Text when another Content domain owns the overview selection", () => {
    const selectionSection = sourceSection(
      "  const explicitlySelectedTextGroupKey = overviewSelection",
      "  const selectedTextGroupKey =",
    );
    const addSection = sourceSection(
      "  const addManagedTextOverviewItem = async () => {",
      "  const openContentMenu =",
    );

    expect(selectionSection).toContain('overviewSelection.domain === "text"');
    expect(selectionSection).toMatch(/overviewSelection\.domain === "text"[\s\S]*?: null/);
    expect(addSection).toContain("afterKey: explicitlySelectedTextGroupKey ?? undefined");
  });

  it("lets a canvas-selected text item switch the active inspector group", () => {
    const selectionSection = sourceSection(
      "  const explicitlySelectedTextGroupKey = overviewSelection",
      "  const managedTextKeys = useMemo(",
    );

    expect(selectionSection).toMatch(
      /selectedManagedTextGroup\(\s*managedTextGroups,\s*selectedTextKey,\s*explicitlySelectedTextGroupKey,?\s*\)/,
    );
  });
});
