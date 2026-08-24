import { describe, expect, it } from "vitest";
import type { MediaMeta } from "../engine/media";
import { mediaCardMenu } from "./mediaCardMenu";

const meta = (kind: "video" | "image"): MediaMeta => ({
  rel: "assets/a",
  kind,
  width: 1920,
  height: 1080,
  fps: kind === "video" ? 60 : 0,
  durationMs: kind === "video" ? 1000 : 0,
  posterPath: "/cache/poster.png",
  scrubPaths: [],
  sha: "abc",
});

const menu = mediaCardMenu({
  slug: "demo",
  primaryLabel: "Insert",
  onPrimary: () => undefined,
  onChanged: () => undefined,
  onError: () => undefined,
});

describe("mediaCardMenu", () => {
  it("offers Edit for videos and stills alike", () => {
    expect(menu("assets/a.mp4", meta("video"), { editedOf: null }).map((i) => i.id)).toContain(
      "edit",
    );
    expect(menu("assets/a.png", meta("image"), { editedOf: null }).map((i) => i.id)).toContain(
      "edit",
    );
  });

  it("waits for the probe, and a rendered output reopens its own edit", () => {
    expect(menu("assets/a.mp4", null, { editedOf: null }).map((i) => i.id)).not.toContain("edit");
    expect(menu("assets/a-edited.mp4", meta("video"), { editedOf: "a" })[0].label).toBe(
      "Open in editor",
    );
  });
});
