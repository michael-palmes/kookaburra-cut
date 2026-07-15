import { useEscapeClose } from "./useEscapeClose";

/** Keyboard-shortcut reference, opened by ⌘/ or Project ▸ Keyboard Shortcuts…; static content, grouped by surface, with the accelerator also on the native menu item for menu-bar discoverability. */
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Preview",
    rows: [
      ["Space", "Play / pause"],
      ["← / →", "Step one frame (⇧ = 10 frames)"],
      ["Esc", "Close the top-most panel, picker or modal"],
    ],
  },
  {
    title: "Editing",
    rows: [
      ["⌘E", "Edit in Claude Code (workspace projects)"],
      ["⌫", "Animation lane: delete the selected keyframe or segment"],
      ["← / →", "Animation lane: nudge the selected keyframe (⇧ = 10 frames)"],
      ["Esc", "Animation lane: disarm the tool, then deselect"],
      ["⌘-drag / ⌃-drag", "Camera tools: pan / zoom while dragging the stage"],
      ["Right-click", "Scenes · theme cards · animation segments: context menu"],
    ],
  },
  {
    title: "Video editor window",
    rows: [
      ["Space", "Play / pause"],
      ["← / →", "Step one frame (⇧ = 10)"],
      ["⌫", "Delete the selected clip"],
      ["Trackpad scroll", "Scrub the playhead"],
    ],
  },
  {
    title: "App",
    rows: [
      ["⌘K", "Find an action (command palette)"],
      ["↑ ↓ · ⏎", "Command palette: navigate · run"],
      ["⌘,", "Settings"],
      ["⌘/", "This sheet"],
    ],
  },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="modal shortcuts-sheet">
        <h2>Keyboard shortcuts</h2>
        {GROUPS.map((g) => (
          <section key={g.title} className="shortcuts-group">
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([keys, what]) => (
                <div key={`${g.title}:${keys}:${what}`} className="shortcuts-row">
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
