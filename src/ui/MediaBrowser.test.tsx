import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_DRAG_TYPE, type MediaMeta, type OriginalFile } from "../engine/media";
import {
  ConformingCard,
  ConformQueue,
  conformCardState,
  conformQueueHeading,
  conformReasonText,
  MediaBrowser,
  MediaBrowserError,
  MediaCard,
  MediaPreviewOverlay,
  mediaCardActions,
  mediaDragData,
  mediaPreviewStep,
  mediaPreviewTabTarget,
  pendingCardItems,
  RemoveOriginalsSheet,
  removeOriginalItem,
  removeOriginalMessage,
  removeOriginalsLabel,
  removeOriginalsMessage,
  runMediaPickSingleFlight,
} from "./MediaBrowser";

// Posters resolve through the asset protocol, which needs a window the node runner lacks.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));

const testProcess = (
  globalThis as unknown as {
    process: {
      getBuiltinModule: (name: "fs") => {
        readFileSync: (path: URL, encoding: "utf8") => string;
      };
    };
  }
).process;
const testFs = testProcess.getBuiltinModule("fs");
const readSource = (path: string) => testFs.readFileSync(new URL(path, import.meta.url), "utf8");
const styles = readSource("../styles.css");

describe("MediaBrowser accessibility", () => {
  it("names the source and media type controls", () => {
    const html = renderToStaticMarkup(
      <MediaBrowser slug="demo" projectPath="/tmp/demo" globalToggle kindToggle hideAdd />,
    );

    expect(html).toContain('role="radiogroup" aria-label="Media source"');
    expect(html).toContain('role="radiogroup" aria-label="Media type"');
  });

  it("collapses the cleanup action into a named ⋯ menu for narrow hosts", () => {
    const html = renderToStaticMarkup(
      <MediaBrowser
        slug="demo"
        projectPath="/tmp/demo"
        globalToggle
        kindToggle
        hideAdd
        cleanupUnused="menu"
      />,
    );

    expect(html).toContain('aria-label="Media actions"');
    expect(html).toContain('aria-haspopup="menu"');
    // The label moves into the menu, which is what frees the Video/Images toggle its width.
    expect(html).not.toContain("Delete unused…");
    expect(html).not.toContain("media-browser-cleanup");
  });

  it("keeps the wide hosts' cleanup action a plain labelled button", () => {
    const html = renderToStaticMarkup(
      <MediaBrowser
        slug="demo"
        projectPath="/tmp/demo"
        globalToggle
        kindToggle
        hideAdd
        cleanupUnused
      />,
    );

    expect(html).toContain("media-browser-cleanup");
    expect(html).toContain("Delete unused…");
    expect(html).not.toContain('aria-label="Media actions"');
  });

  it("stops the ⋯ overflow taking the media type toggle's width back", () => {
    expect(styles).toMatch(/\.media-browser-more\s*\{[^}]*flex:\s*none/);
  });

  it("announces operational errors", () => {
    const html = renderToStaticMarkup(<MediaBrowserError message="Import failed" />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Import failed");
  });

  it("keeps player controls reachable while wrapping focus at dialog boundaries", () => {
    const playerControl = { id: "player" } as HTMLElement;
    const close = { id: "close" } as HTMLElement;
    const outside = { id: "outside" } as HTMLElement;
    const focusables = [playerControl, close];

    expect(mediaPreviewTabTarget(focusables, playerControl, false)).toBeNull();
    expect(mediaPreviewTabTarget(focusables, close, true)).toBeNull();
    expect(mediaPreviewTabTarget(focusables, close, false)).toBe(playerControl);
    expect(mediaPreviewTabTarget(focusables, playerControl, true)).toBe(close);
    expect(mediaPreviewTabTarget(focusables, outside, false)).toBe(playerControl);
    expect(mediaPreviewTabTarget(focusables, outside, true)).toBe(close);
    expect(mediaPreviewTabTarget([], outside, false)).toBeNull();
  });

  it("keeps card activation, preview and actions as separate controls", () => {
    const html = renderToStaticMarkup(
      <MediaCard
        rel="assets/icon.png"
        meta={null}
        metaFailed={false}
        edited={false}
        canDrag={false}
        selected
        disabled
        onPick={() => undefined}
        onPreview={() => undefined}
        onMenu={() => undefined}
      />,
    );

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('aria-label="Use icon.png" aria-pressed="true"');
    expect(html).toContain('class="media-card-activate"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Preview icon.png"');
    expect(html).toContain('aria-label="Actions for icon.png"');
    expect(html.match(/<button/g)).toHaveLength(3);
    const activation = html.slice(html.indexOf("<button"), html.indexOf("</button>") + 9);
    expect(activation).not.toContain("<img");
    expect(activation.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the card activation focus ring inside the card", () => {
    expect(styles).toMatch(
      /\.media-card-activate:focus-visible\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--focus-ring\)/,
    );
  });

  it("runs card, Preview and Actions controls independently", () => {
    const pick = vi.fn();
    const preview = vi.fn();
    const menu = vi.fn();
    const actions = mediaCardActions(pick, preview, menu);

    actions.activate();
    expect(pick).toHaveBeenCalledTimes(1);

    actions.preview();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);

    actions.openMenu?.(12, 24);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenCalledWith(12, 24);
  });

  it("allows only one copy-on-use pick at a time", async () => {
    const busyRef = { current: false };
    let release: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = runMediaPickSingleFlight(busyRef, task);
    const second = runMediaPickSingleFlight(busyRef, task);

    expect(task).toHaveBeenCalledTimes(1);
    expect(busyRef.current).toBe(true);
    await expect(second).resolves.toBe(false);
    release?.();
    await expect(first).resolves.toBe(true);
    expect(busyRef.current).toBe(false);
  });
});

describe("panel-scoped media preview", () => {
  it("steps through the visible grid and wraps at both ends", () => {
    const list = ["assets/a.png", "assets/b.png", "assets/c.png"];

    expect(mediaPreviewStep(list, "assets/a.png", 1)).toBe("assets/b.png");
    expect(mediaPreviewStep(list, "assets/c.png", 1)).toBe("assets/a.png");
    expect(mediaPreviewStep(list, "assets/a.png", -1)).toBe("assets/c.png");
    expect(mediaPreviewStep(["assets/only.png"], "assets/only.png", 1)).toBe("assets/only.png");
    expect(mediaPreviewStep(["assets/only.png"], "assets/only.png", -1)).toBe("assets/only.png");
    expect(mediaPreviewStep([], "assets/gone.png", 1)).toBeNull();
    // A refresh that dropped the previewed file restarts from the top of the grid.
    expect(mediaPreviewStep(list, "assets/gone.png", 1)).toBe("assets/b.png");
    expect(mediaPreviewStep(list, "assets/gone.png", -1)).toBe("assets/c.png");
  });

  it("adds prev/next chevrons only when scoped to the inspector panel", () => {
    const panel = renderToStaticMarkup(
      <MediaPreviewOverlay
        name="assets/shot.png"
        src="asset://assets/shot.png"
        kind="image"
        panel
        canStep
        onStep={() => undefined}
        onClose={() => undefined}
        closeRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(panel).toContain('class="media-preview panel"');
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain('aria-label="Preview assets/shot.png"');
    expect(panel).toContain('aria-label="Previous file"');
    expect(panel).toContain('aria-label="Next file"');
    expect(panel).toContain('class="toast-close media-preview-close"');
    // Tab order: player controls, prev, next, close.
    expect(panel.indexOf("media-preview-step prev")).toBeLessThan(
      panel.indexOf("media-preview-step next"),
    );
    expect(panel.indexOf("media-preview-step next")).toBeLessThan(
      panel.indexOf("media-preview-close"),
    );

    const windowWide = renderToStaticMarkup(
      <MediaPreviewOverlay
        name="assets/shot.png"
        src="asset://assets/shot.png"
        kind="image"
        canStep
        onStep={() => undefined}
        onClose={() => undefined}
        closeRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(windowWide).toContain('class="media-preview"');
    expect(windowWide).not.toContain("media-preview-step");
  });

  it("disables the chevrons when the grid holds a single file", () => {
    const html = renderToStaticMarkup(
      <MediaPreviewOverlay
        name="assets/only.png"
        src="asset://assets/only.png"
        kind="image"
        panel
        canStep={false}
        onStep={() => undefined}
        onClose={() => undefined}
        closeRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(html.match(/class="media-preview-step [a-z]+" [^>]*disabled=""/g)).toHaveLength(2);
  });

  it("scopes the panel overlay to the drill and fits the player to the rail", () => {
    // The modal and editor hosts keep the window-wide preview.
    expect(styles).toMatch(/\.media-preview\s*\{[^}]*position: fixed;/s);
    expect(styles).toMatch(/\.media-preview\.panel\s*\{[^}]*position: absolute;[^}]*inset: 0;/s);
    // The base bar's 320px floor overflows the 342px rail.
    expect(styles).toMatch(/\.media-preview\.panel \.video-player-bar\s*\{[^}]*min-width: 0;/s);
    expect(styles).toContain(".media-preview-step {");
  });

  it("keeps the window-wide preview on the modal and editor hosts", () => {
    for (const path of [
      "./MediaLibrary.tsx",
      "./SceneWizards.tsx",
      "./SceneTextFields.tsx",
      "../editor/EditorApp.tsx",
    ]) {
      expect(readSource(path)).not.toContain("inspectorPreview");
    }
  });

  it("stands the timeline transport down while a preview is open", () => {
    expect(readSource("../App.tsx")).toContain(
      'if (document.querySelector(".media-preview")) return;',
    );
  });

  it("flags a probed clip, and shows a running conform instead", () => {
    const card = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(
        <MediaCard
          rel="assets/rec.mov"
          meta={null}
          metaFailed={false}
          edited={false}
          canDrag={false}
          selected={false}
          onPreview={() => undefined}
          {...extra}
        />,
      );
    const flagged = card({ needsConform: "Needs conform: variable frame rate." });
    expect(flagged).toContain(">Needs conform</span>");
    expect(flagged).toContain('title="Needs conform: variable frame rate."');
    const running = card({ needsConform: "x", conforming: 42 });
    expect(running).toContain("Conforming… 42%");
    expect(running).not.toContain(">Needs conform<");
    expect(card({ edited: true, needsConform: "x", conforming: 5 })).not.toContain("onforming");
    expect(card({})).not.toContain("conform");
  });

  it("names what the probe found in words", () => {
    expect(conformReasonText({ why: ["vfr", "primaries"] })).toBe(
      "Needs conform: variable frame rate, wide colour (P3). Conform from the ⋯ menu.",
    );
    expect(conformReasonText({ why: ["decoders", "novel"] })).toBe(
      "Needs conform: decoders disagree, novel. Conform from the ⋯ menu.",
    );
    expect(conformReasonText({ why: [] })).toBe("Needs conform");
  });
});

describe("placing a clip while it conforms", () => {
  const job = {
    slug: "product-tour",
    rel: "assets/rec.mp4",
    original: "assets/.originals/rec.mov",
    frame: 30,
    total: 120,
  };
  const pendingMeta: MediaMeta = {
    rel: "assets/rec.mp4",
    kind: "video",
    width: 1179,
    height: 2556,
    fps: 60,
    durationMs: 30_000,
    posterPath: "/cache/media/abc/poster.jpg",
    scrubPaths: [],
    sha: "a".repeat(64),
  };
  const card = (extra: Partial<Parameters<typeof ConformingCard>[0]> = {}) =>
    renderToStaticMarkup(
      <ConformingCard
        job={job}
        meta={pendingMeta}
        canDrag
        selected={false}
        onPreview={() => undefined}
        {...extra}
      />,
    );

  it("drags and picks under the final path, with the original's poster", () => {
    const html = card({ onPick: () => undefined, onMenu: () => undefined });
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="Use rec.mp4"');
    expect(html).toContain('aria-label="Actions for rec.mp4"');
    expect(html).toContain("Conforming… 25%");
    expect(html).toContain("poster.jpg");
    expect(html).toContain("1179×2556 · 60 fps");
    expect(mediaDragData(job.rel)).toEqual([
      [MEDIA_DRAG_TYPE, "assets/rec.mp4"],
      ["text/plain", "assets/rec.mp4"],
    ]);
  });

  it("waits to be draggable until its card meta is read, and says when it waits for a slot", () => {
    const early = card({ meta: null, job: { ...job, frame: 0, total: 0 } });
    expect(early).not.toContain('draggable="true"');
    expect(early).toContain("Waiting to conform");
    expect(card({ canDrag: false })).not.toContain('draggable="true"');
    expect(conformCardState({ frame: 0, total: 0 })).toBe("waiting");
    expect(conformCardState({ frame: 60, total: 120 })).toBe(50);
  });

  it("keeps the host's placing action and offers a confirmed stop", () => {
    const host = [
      { id: "edit", label: "Edit", onSelect: () => undefined },
      { id: "primary", label: "Select", onSelect: () => undefined },
      { id: "add-global", label: "Add to library", onSelect: () => undefined },
      { id: "delete", label: "Delete", danger: true, onSelect: () => undefined },
    ];
    const stop = vi.fn();
    const items = pendingCardItems(host, "/Users/x/product-tour/assets/rec.mp4", stop);
    expect(items.map((item) => item.id)).toEqual(["primary", "copy-path", "cancel-conform"]);
    const cancel = items[2];
    expect(cancel.icon).toBeTruthy();
    expect(cancel.confirmLabel).toBe("Really stop?");
    cancel.onSelect();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("lists the queue in order with progress, waiting rows and a two-step stop", () => {
    const jobs = [
      job,
      { ...job, rel: "assets/rec-2.mp4", frame: 0, total: 0 },
      { ...job, rel: "assets/demo.mp4", frame: 90, total: 90 },
    ];
    const html = renderToStaticMarkup(
      <ConformQueue jobs={jobs} armed="assets/rec-2.mp4" onCancel={() => undefined} />,
    );
    expect(html).toContain('aria-label="Conform queue"');
    expect(html).toContain("Conforming 3 videos, 1 waiting");
    expect(html.indexOf("rec.mp4")).toBeLessThan(html.indexOf("rec-2.mp4"));
    expect(html.indexOf("rec-2.mp4")).toBeLessThan(html.indexOf("demo.mp4"));
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain(">Waiting<");
    expect(html).toContain('aria-label="Cancel conforming rec.mp4"');
    expect(html).toContain('aria-label="Stop conforming rec-2.mp4"');
    expect(html).toContain(">Stop?<");
    // The heading's icon plus one stop icon per row.
    expect(html.match(/<svg/g)?.length).toBe(4);
    expect(
      renderToStaticMarkup(<ConformQueue jobs={[]} armed={null} onCancel={() => undefined} />),
    ).toBe("");
    expect(conformQueueHeading([job])).toBe("Conforming 1 video");
    expect(conformQueueHeading([job, job])).toBe("Conforming 2 videos");
  });
});

describe("removing originals", () => {
  const MB = 1024 * 1024;
  const original = (extra: Partial<OriginalFile>): OriginalFile => ({
    rel: "assets/.originals/rec.mov",
    bytes: 24 * MB,
    clip: "assets/rec.mp4",
    busy: null,
    ...extra,
  });

  it("names the clip, the size and that the clip stays", () => {
    expect(removeOriginalMessage("assets/rec.mp4", 24 * MB)).toBe(
      "Remove the original of rec.mp4 (24.0 MB)? The conformed clip stays.",
    );
    expect(removeOriginalsLabel(240 * MB)).toBe("Remove originals (240 MB)…");
    expect(
      removeOriginalsMessage([
        original({}),
        original({ rel: "assets/.originals/b.mov", bytes: 8 * MB }),
        original({ rel: "assets/.originals/c.mov", busy: "c.mov is still conforming" }),
      ]),
    ).toBe(
      "Move 2 originals (32.0 MB) to the Trash? The conformed clips stay. 1 still in use stays.",
    );
    expect(removeOriginalsMessage([original({})])).toBe(
      "Move the original (24.0 MB) to the Trash? The conformed clips stay.",
    );
  });

  it("opens the confirmation from the clip menu, or says why it can't yet", () => {
    const open = vi.fn();
    const item = removeOriginalItem(original({}), "assets/rec.mp4", open);
    expect(item.label).toBe("Remove original…");
    expect(item.icon).toBeTruthy();
    expect(item.disabled).toBe(false);
    item.onSelect();
    expect(open).toHaveBeenCalledWith({
      kind: "one",
      original: original({}),
      clip: "assets/rec.mp4",
    });
    const busy = removeOriginalItem(original({ busy: "rec.mov is still conforming" }), "x", open);
    expect(busy.disabled).toBe(true);
    expect(busy.title).toBe("rec.mov is still conforming");
  });

  it("confirms as a dialog that moves to the Trash", () => {
    const html = renderToStaticMarkup(
      <RemoveOriginalsSheet
        title="Remove original"
        message={removeOriginalMessage("assets/rec.mp4", 24 * MB)}
        run={async () => ({ count: 1, bytes: 24 * MB })}
        onDone={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Remove original"');
    expect(html).toContain("The conformed clip stays.");
    expect(html).toContain("Move to Trash");
  });
});
