import { useSingleKeyShortcuts } from "./chromePrefs";
import { useEscapeClose } from "./useEscapeClose";

/** Keyboard-shortcut reference, opened by ⌘/ or Project ▸ Keyboard Shortcuts…; static content, grouped by surface, with the accelerator also on the native menu item for menu-bar discoverability. */
export const GROUPS: { title: string; rows: [string, string][] }[] = [
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
      ["⌥⌘E", "Edit with Claude (workspace projects)"],
      ["⌫", "Animation lane: delete the focused or selected keyframe or animation"],
      ["← / →", "Animation lane: nudge the selected keyframe (⇧ = 10 frames)"],
      [
        "Esc",
        "Animation lane: disarm the tool, then deselect; from a focused item, back to the lane",
      ],
      ["Tab", "Animation lane: focus its keyframes and animations, one stop per lane"],
      ["← / → · Home / End", "Animation lane, focused: previous or next item, first or last"],
      ["↑ / ↓", "Animation lanes, focused: the lane above or below"],
      ["⏎ or Space", "Animation lane, focused: select (again on a chart keyframe: open its data)"],
      ["⌘← / ⌘→", "Animation lane, focused: move the keyframe or animation one frame (⇧ = 10)"],
      ["⌥← / ⌥→", "Animation lane, focused: move an animation's start one frame (⇧ = 10)"],
      ["⌥⌘← / ⌥⌘→", "Animation lane, focused: move an animation's end one frame (⇧ = 10)"],
      ["O / P / Z", "Camera tools, Orbit mode: arm Orbit / Pan / Zoom (animation mode open)"],
      ["M / F / L / T", "Camera tools, Free mode: arm Move / Forward / Look / Tilt"],
      ["⌘ / ⌃ / ⌥ + drag", "Camera tools: slide / dolly / turn while dragging the stage"],
      ["Click", "Gizmos: select an item on the stage (its inspector section open)"],
      ["⌘ / ⌃ / ⌥ + drag", "Gizmos: keep flying the camera over a gizmo handle"],
      ["⇧ while dragging", "Gizmos, text and decorations: snap a rotation to 15°"],
      [
        "⌃ while dragging",
        "Gizmos, text, hero charts and decorations: turn off alignment snapping",
      ],
      ["Right-click", "Scenes · theme cards · keyframes · animations: context menu"],
      [
        "⇧F10",
        "Scenes list, scene overview, text rows, theme cards and focused lane items: the same menu",
      ],
    ],
  },
  {
    title: "Video editor window",
    rows: [
      ["Space", "Play / pause"],
      ["← / →", "Step one frame (⇧ = 10)"],
      ["S", "Split the clip under the playhead"],
      ["F", "Freeze the frame under the playhead"],
      ["T", "Tap tool: click the preview to place a tap highlight"],
      ["M", "Mask tool: drag over the preview to hide an area"],
      ["⌥ while dragging", "Mask: move its whole path instead of keying this frame"],
      ["⌫", "Delete the selected mask or clip, or the focused timeline item"],
      ["Trackpad scroll", "Scrub the playhead"],
      ["Right-click", "Clip · zoom key · tap marker · mask: context menu"],
      ["Tab", "Timeline: focus its clips, then its masks, one stop per lane"],
      ["← / → · Home / End", "Timeline, focused: previous or next clip or zoom key, first or last"],
      ["↑ / ↓", "Timeline, focused: the clips or masks lane"],
      ["⏎ or Space", "Timeline, focused: select a clip or mask, or jump to a zoom key"],
      ["⌘← / ⌘→", "Timeline, focused: move a clip one place, or a zoom key one frame (⇧ = 10)"],
      ["⌥← / ⌥→", "Timeline, focused: trim a clip's or mask's start one frame (⇧ = 10)"],
      ["⌥⌘← / ⌥⌘→", "Timeline, focused: trim a clip's or mask's end, or a freeze's length"],
      ["⇧F10", "Timeline, focused: the item's menu"],
    ],
  },
  {
    title: "App",
    rows: [
      ["⌘K", "Find an action (command palette)"],
      ["⌘F", "Welcome screen: search your projects"],
      ["↑ ↓ · ⏎", "Command palette: navigate · run"],
      ["⌘,", "Settings"],
      ["⌘/", "This sheet"],
    ],
  },
];

/** Rows whose keys are bare letters, which Settings › Single-key shortcuts can turn off. */
export function isSingleKeyRow(keys: string): boolean {
  return /^[A-Z](?: \/ [A-Z])*$/.test(keys);
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  const singleKey = useSingleKeyShortcuts();
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="modal shortcuts-sheet">
        <h2>Keyboard shortcuts</h2>
        <p className="shortcuts-note">
          {singleKey
            ? "Letter keys work unless you're typing. Turn them off in Settings › Accessibility."
            : "Single-key shortcuts are off in Settings › Accessibility, so letter keys do nothing."}
        </p>
        {GROUPS.map((g) => (
          <section key={g.title} className="shortcuts-group">
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map(([keys, what]) => (
                <div key={`${g.title}:${keys}:${what}`} className="shortcuts-row">
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>
                    {what}
                    {!singleKey && isSingleKeyRow(keys) && " (off)"}
                  </dd>
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
