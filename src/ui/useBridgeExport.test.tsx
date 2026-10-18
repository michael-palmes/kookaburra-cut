import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeProgress } from "../engine/bridgeExport";
import { BridgeExportOverlay, bridgeStageText, etaText } from "./BridgeExportOverlay";
import {
  clearExportCard,
  type FlaggedExport,
  type FlashOutcome,
  flashNotice,
  noteExportFlashes,
  onFlaggedExport,
} from "./FlashWarning";
import { FIELD_EDIT_IDLE_MS, FieldActivity, isEditingFocus } from "./useBridgeExport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const el = (tagName: string, extra: Record<string, unknown> = {}, inTerminal = false) => ({
  tagName,
  closest: (selector: string) => (inTerminal && selector.includes(".xterm") ? {} : null),
  ...extra,
});

describe("isEditingFocus", () => {
  it("counts text fields, selects and editable regions as mid-edit", () => {
    expect(isEditingFocus(el("INPUT"))).toBe(true);
    expect(isEditingFocus(el("input", { type: "number" }))).toBe(true);
    expect(isEditingFocus(el("TEXTAREA"))).toBe(true);
    expect(isEditingFocus(el("SELECT"))).toBe(true);
    expect(isEditingFocus(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("ignores buttons, toggles, the page itself and the embedded Claude terminal", () => {
    expect(isEditingFocus(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isEditingFocus(el("INPUT", { type: "range" }))).toBe(false);
    expect(isEditingFocus(el("BUTTON"))).toBe(false);
    expect(isEditingFocus(el("BODY"))).toBe(false);
    expect(isEditingFocus(null)).toBe(false);
    expect(isEditingFocus(el("TEXTAREA", {}, true))).toBe(false);
  });
});

describe("FieldActivity (a focused field blocks kb export only while the person types)", () => {
  const field = el("INPUT");

  it("lets an idle focused field through", () => {
    const fields = new FieldActivity();
    expect(fields.editing(field, 1_000)).toBe(false);
    fields.note(field, 1_000);
    expect(fields.editing(field, 1_000 + FIELD_EDIT_IDLE_MS - 1)).toBe(true);
    expect(fields.editing(field, 1_000 + FIELD_EDIT_IDLE_MS)).toBe(false);
  });

  it("counts typing or a change in any field, but only while one is focused", () => {
    const fields = new FieldActivity();
    fields.note(el("SELECT"), 5_000);
    expect(fields.editing(field, 6_000)).toBe(true);
    expect(fields.editing(el("BUTTON"), 6_000)).toBe(false);
    expect(fields.editing(null, 6_000)).toBe(false);
  });

  it("never counts the embedded Claude terminal or a toggle", () => {
    const fields = new FieldActivity();
    fields.note(el("TEXTAREA", {}, true), 1_000);
    fields.note(el("INPUT", { type: "checkbox" }), 1_000);
    expect(fields.editing(field, 2_000)).toBe(false);
    expect(fields.editing(el("TEXTAREA", {}, true), 2_000)).toBe(false);
  });
});

const progress = (over: Partial<BridgeProgress>): BridgeProgress => ({
  stage: "render",
  run: 1,
  runs: 1,
  prepareStep: 0,
  prepareSteps: 4,
  prepareLabel: "Loading fonts and clips",
  frame: 1234,
  total: 3901,
  percent: 31.6,
  renderFps: 4.1,
  elapsedMs: 300_000,
  etaMs: 645_000,
  ...over,
});

describe("BridgeExportOverlay", () => {
  it("says Claude is exporting, how far, and offers the person's Cancel with its icon", () => {
    const html = renderToStaticMarkup(
      <BridgeExportOverlay
        state={{
          id: "a",
          verify: false,
          client: "alpha",
          progress: progress({}),
          cancelling: false,
        }}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Claude is exporting, 31%");
    expect(html).toContain("Frame 1234 of 3901, about 11 min left");
    expect(html).toMatch(/<button[^>]*bridge-export-cancel[^>]*><svg/);
    expect(html).toContain("Cancel");
    expect(renderToStaticMarkup(<BridgeExportOverlay state={null} onCancel={() => {}} />)).toBe("");
  });

  it("names each stage", () => {
    expect(bridgeStageText(progress({ stage: "syncing" }), false)).toBe(
      "Picking up the latest changes",
    );
    expect(bridgeStageText(progress({ stage: "preparing" }), false)).toBe(
      "Loading fonts and clips",
    );
    expect(bridgeStageText(progress({ etaMs: null, run: 2, runs: 2 }), true)).toBe(
      "Frame 1234 of 3901 (render 2 of 2)",
    );
    expect(bridgeStageText(progress({ stage: "pass2" }), false)).toBe("Encoding, pass 2 of 2");
    expect(etaText(40_000)).toBe("about 40 s left");
    expect(etaText(2 * 3_600_000 + 5 * 60_000)).toBe("about 2 h 5 min left");
    expect(etaText(null)).toBeNull();
  });
});

describe("flashNotice", () => {
  const issue = (severity: string, startMs: number) => ({
    type: "general",
    standard: "wcag",
    severity,
    startMs,
    endMs: startMs + 1000,
    tc: `00:${String(startMs / 1000).padStart(2, "0")}.000`,
    flashesPerSecond: 4.5,
    areaPct: 38.2,
    hint: "hold each state at least 334 ms, or keep the change under 10% luminance",
  });
  const outcome = (issues: ReturnType<typeof issue>[]): FlashOutcome => ({
    path: "/Users/x/Downloads/demo-16x9.mp4",
    report: { ok: !issues.some((i) => i.severity === "fail"), issues },
    unavailable: null,
  });

  it("warns with timecodes and where the report is saved", () => {
    const notice = flashNotice(outcome([issue("fail", 41_000), issue("warn", 50_000)]));
    expect(notice?.tone).toBe("danger");
    expect(notice?.title).toBe(
      "Your cut is ready, but it flashes enough to risk seizures (1 moment)",
    );
    expect(notice?.lines[0]).toBe(
      "00:41.000, 1.0 s: 4.5 flashes a second over 38.2% of the frame (fails WCAG 2.3.1)",
    );
    expect(notice?.hint).toBe(
      "Hold each state at least 334 ms, or keep the change under 10% luminance. The report is saved beside the export as demo-16x9.mp4.flashes.json.",
    );
    expect(flashNotice(outcome([issue("warn", 2000)]))?.tone).toBe("warning");
  });

  it("names Claude when Claude ran the export", () => {
    const flagged = outcome([issue("fail", 41_000)]);
    expect(flashNotice(flagged, "claude")?.title).toBe(
      "Claude's export is ready, but it flashes enough to risk seizures (1 moment)",
    );
    expect(flashNotice(outcome([issue("warn", 2000)]), "claude")?.title).toBe(
      "Claude's export is ready, but it comes close to the flash limits",
    );
    expect(flashNotice(flagged)?.title).toMatch(/^Your cut is ready/);
  });

  it("reads one stretch flagged by both standards as one moment", () => {
    const both = outcome([
      { ...issue("fail", 2000), standard: "itu", areaPct: 100 },
      { ...issue("fail", 2000), areaPct: 99.8 },
      { ...issue("fail", 9000), type: "red" },
    ]);
    const notice = flashNotice(both);
    expect(notice?.title).toMatch(/\(2 moments\)$/);
    expect(notice?.lines).toEqual([
      "00:02.000, 1.0 s: 4.5 flashes a second over the whole frame (fails WCAG 2.3.1 and ITU-R BT.1702)",
      "00:09.000, 1.0 s: 4.5 flashes a second over 38.2% of the frame (red flash, fails WCAG 2.3.1)",
    ]);
  });

  it("stays quiet for a clean film or no report", () => {
    expect(flashNotice(outcome([]))).toBeNull();
    expect(
      flashNotice({ path: "/x.mp4", report: null, unavailable: "flash check unavailable" }),
    ).toBeNull();
    expect(flashNotice(null)).toBeNull();
  });
});

describe("noteExportFlashes", () => {
  const flagged: FlashOutcome = {
    path: "/Users/x/Kookaburra Cut/demo/exports/demo-16x9.mp4",
    report: {
      ok: false,
      issues: [
        {
          type: "general",
          standard: "wcag",
          severity: "fail",
          startMs: 1000,
          endMs: 2000,
          tc: "00:01.000",
          flashesPerSecond: 5,
          areaPct: 40,
          hint: "slow the strobe",
        },
      ],
    },
    unavailable: null,
  };
  const heard: (FlaggedExport | null)[] = [];
  beforeEach(() => {
    heard.length = 0;
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(flagged);
  });

  it("raises the warning for Claude's export, and a verify's latest report", async () => {
    const off = onFlaggedExport((f) => heard.push(f));
    expect(await noteExportFlashes(flagged.path, "claude")).toBe(true);
    await noteExportFlashes(null, "claude");
    expect(await noteExportFlashes("/Users/x/Downloads/other.mp4", "claude")).toBe(false);
    await noteExportFlashes(flagged.path);
    off();
    await noteExportFlashes(flagged.path, "claude");
    expect(mocks.invoke).toHaveBeenCalledWith("export_flash_report");
    expect(heard.map((f) => f?.origin ?? null)).toEqual(["claude", "claude", null, "button"]);
    expect(heard[0]?.outcome).toBe(flagged);
  });

  it("clears the card for a clean film", async () => {
    mocks.invoke.mockResolvedValue({ ...flagged, report: { ok: true, issues: [] } });
    const off = onFlaggedExport((f) => heard.push(f));
    expect(await noteExportFlashes(null, "claude")).toBe(false);
    off();
    expect(heard).toEqual([null]);
  });

  it("clears the card when a new run starts", () => {
    const off = onFlaggedExport((f) => heard.push(f));
    clearExportCard();
    off();
    expect(heard).toEqual([null]);
  });
});
