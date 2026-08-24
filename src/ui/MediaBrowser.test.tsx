import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MediaBrowser,
  MediaBrowserError,
  MediaCard,
  MediaPreviewOverlay,
  mediaCardActions,
  mediaPreviewStep,
  mediaPreviewTabTarget,
  runMediaPickSingleFlight,
} from "./MediaBrowser";

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
});
