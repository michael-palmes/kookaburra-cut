import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BridgeProgress } from "../engine/bridgeExport";
import { BridgeExportOverlay, bridgeStageText, etaText } from "./BridgeExportOverlay";
import { type FlashOutcome, flashNotice } from "./FlashWarning";
import { isEditingFocus } from "./useBridgeExport";

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
    expect(notice?.title).toMatch(/1 moment\)/);
    expect(notice?.lines[0]).toBe(
      "00:41.000 for 1.0 s: 4.5 flashes a second over 38.2% of the frame (WCAG general, fails)",
    );
    expect(notice?.hint).toBe(
      "Hold each state at least 334 ms, or keep the change under 10% luminance. The report is saved beside the export as demo-16x9.mp4.flashes.json.",
    );
    expect(flashNotice(outcome([issue("warn", 2000)]))?.tone).toBe("warning");
  });

  it("stays quiet for a clean film or no report", () => {
    expect(flashNotice(outcome([]))).toBeNull();
    expect(
      flashNotice({ path: "/x.mp4", report: null, unavailable: "flash check unavailable" }),
    ).toBeNull();
    expect(flashNotice(null)).toBeNull();
  });
});
