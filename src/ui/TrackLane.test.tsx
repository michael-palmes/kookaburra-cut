import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { KeyedTrack } from "../engine/keyedTrack";
import { TrackLane } from "./TrackLane";

type Track = KeyedTrack<{ x: number }>;

const track: Track = {
  keys: [
    { id: "a", tMs: 0, pose: { x: 0 } },
    { id: "b", tMs: 1000, pose: { x: 1 } },
  ],
  segments: [{ from: "a", to: "b", ease: "linear" }],
};

function render(selectedKeyId: string | null, laneName?: string) {
  return renderToStaticMarkup(
    <TrackLane<{ x: number }, Track>
      open
      slotStartMs={0}
      durationMs={2000}
      windowStartMs={0}
      windowEndMs={2000}
      transitionInMs={0}
      transitionOutStartMs={2000}
      lastScene
      track={track}
      selectedKeyId={selectedKeyId}
      selectedSegment={null}
      writeError={null}
      select={vi.fn()}
      getSelection={() => ({ keyId: selectedKeyId, segment: null })}
      onToolKey={() => false}
      onEscape={vi.fn()}
      preview={vi.fn()}
      commit={vi.fn()}
      poseAt={() => ({ x: 0 })}
      onSceneDuration={vi.fn()}
      addTitle="Add"
      writeErrorPrefix="Save failed:"
      laneName={laneName}
    />,
  );
}

describe("TrackLane roles and names", () => {
  it("reads as a named list of keyframes and animations with positions", () => {
    const html = render(null, "Camera");
    expect(html).toContain('role="listbox" aria-label="Camera animations"');
    expect(html).toContain('aria-label="Keyframe, 0:00.00" aria-posinset="1" aria-setsize="3"');
    expect(html).toContain('aria-label="Animation, Linear, 0:00.00 to 0:01.00" aria-posinset="2"');
    expect(html).toContain('aria-label="Keyframe, 0:01.00" aria-posinset="3"');
    expect(html).toContain('role="status"');
  });

  it("is one Tab stop, the selected item when there is one", () => {
    const first = render(null).match(/tabindex="0"/g);
    expect(first).toHaveLength(1);
    const selected = render("b");
    expect(selected.match(/tabindex="0"/g)).toHaveLength(1);
    expect(selected).toMatch(/role="option" tabindex="0" aria-selected="true"/);
  });
});
