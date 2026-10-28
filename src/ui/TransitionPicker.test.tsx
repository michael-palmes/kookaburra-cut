import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectMusic } from "../engine/musicTime";
import type { LoadedProject } from "../engine/project";
import type { TransitionSpec } from "../engine/sceneTimeline";
import { FEEL_LABELS, FEEL_ORDER, TRANSITION_CATALOG } from "../engine/transitionCatalog";
import { TransitionModal } from "./TransitionPicker";

const colors = { background: "#0b0f14", text: "#ffffff", accent: "#3ddbc9", muted: "#888888" };

function projectStub(transition?: TransitionSpec, music?: ProjectMusic): LoadedProject {
  return {
    music,
    slots: [
      { index: 0, id: "a", startMs: 0, endMs: 1800, durationMs: 1800 },
      {
        index: 1,
        id: "b",
        startMs: 1100,
        endMs: 2900,
        durationMs: 1800,
        ...(transition ? { transitionIn: transition } : {}),
      },
    ],
    sceneFiles: ["scenes/01-a.tsx", "scenes/02-b.tsx"],
    sceneThemes: [],
    theme: { colors },
  } as unknown as LoadedProject;
}

function render(transition?: TransitionSpec, music?: ProjectMusic): string {
  return renderToStaticMarkup(
    <TransitionModal
      embedded
      project={projectStub(transition, music)}
      boundaryIndex={0}
      thumbs={{}}
      onCancel={() => {}}
      onApply={async () => {}}
    />,
  );
}

describe("TransitionModal", () => {
  it("renders every catalogue card under the four feel groups plus None", () => {
    const html = render();
    expect(html).toContain("None (cut)");
    for (const m of TRANSITION_CATALOG) {
      expect(html, m.type).toContain(`>${m.label}</span>`);
    }
    for (const feel of FEEL_ORDER) {
      expect(html).toContain(FEEL_LABELS[feel].replaceAll("&", "&amp;"));
    }
  });

  it("renders the schema param rows for the applied type", () => {
    const html = render({ type: "glasssweep", durationMs: 700 });
    expect(html).toContain("Bar width");
    expect(html).toContain("Refraction");
  });

  it("renders choice chips with per-type labels", () => {
    const html = render({ type: "luma", durationMs: 600, shape: "iris" });
    expect(html).toContain("Ramp");
    expect(html).toContain("Iris");
    expect(html).toContain("Radial");
  });

  it("offers to keep later scenes on the beat and names the bar the cut lands on", () => {
    // 100 bpm with bar 1 at 200 ms: a beat is 600 ms, so the crossfade's middle (1450 ms) is off the beat.
    const music = (offsetMs: number): ProjectMusic => ({
      grid: { bpm: 100, offsetMs, beatsPerBar: 4 },
      startOffsetMs: 0,
      cues: {},
      sections: {},
    });
    const fade = { type: "crossfade" as const, durationMs: 700 };
    expect(render(fade)).not.toContain("Keep later scenes on the beat");
    expect(render(fade, music(200))).toContain("The cut lands at 1.45 s, off the beat");
    const onBeat = render(fade, music(250));
    expect(onBeat).toContain("Keep later scenes on the beat");
    expect(onBeat).toContain("The cut lands on bar 1, beat 3");
    expect(onBeat).toContain("Hard cut on the same beat");
  });
});
