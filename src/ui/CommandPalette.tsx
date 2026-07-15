import { useEffect, useMemo, useRef, useState } from "react";
import { type CommandContext, searchCommands } from "./commandRegistry";
import { useEscapeClose } from "./useEscapeClose";

/** The ⌘K command palette (design.md §8.8): pure render over `searchCommands`, every command comes from the registry (ui/commandRegistry.ts). The overlay carries `.modal-overlay` so App's transport keydown and the camera lane's nudge handler stand down while it's open, silencing Space/←/→/⌫ for free (the same contract every modal rides). */
export function CommandPalette({ ctx, onClose }: { ctx: CommandContext; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEscapeClose(onClose);

  const groups = useMemo(() => searchCommands(query, ctx), [query, ctx]);
  const flat = useMemo(() => groups.flatMap((g) => g.commands), [groups]);
  const active = flat[Math.min(activeIndex, flat.length - 1)] ?? null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the active row visible while ↑/↓ walks the list.
  useEffect(() => {
    if (!active) return;
    listRef.current
      ?.querySelector(`[data-command-id="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (cmd: (typeof flat)[number]) => {
    // Close first: commands that open modals mount their own Escape layer, and the palette must not linger underneath it.
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i + 1, flat.length - 1)));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) run(active);
    }
  };

  return (
    <div
      className="modal-overlay palette-overlay"
      role="dialog"
      aria-modal="true"
      onPointerDown={onClose}
    >
      {/* Click-away lives on the overlay only, the panel swallows its own clicks. */}
      <div
        className="command-palette"
        onPointerDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Find an action…"
          aria-label="Find an action"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={active ? `palette-cmd-${active.id}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-results" id="palette-results" role="listbox" ref={listRef}>
          {groups.map((g) => (
            <div key={g.group} className="palette-group">
              <div className="palette-group-label" aria-hidden>
                {g.group}
              </div>
              {g.commands.map((cmd) => (
                <div
                  key={cmd.id}
                  id={`palette-cmd-${cmd.id}`}
                  data-command-id={cmd.id}
                  className={`palette-row${cmd === active ? " palette-row-active" : ""}`}
                  role="option"
                  aria-selected={cmd === active}
                  // Focus stays in the input (the aria-activedescendant combobox pattern); -1 keeps rows programmatically focusable only.
                  tabIndex={-1}
                  onPointerMove={() => {
                    const i = flat.indexOf(cmd);
                    if (i >= 0 && i !== activeIndex) setActiveIndex(i);
                  }}
                  onPointerDown={(e) => {
                    // pointerdown, not click: the input keeps focus, and a fast pick can't race the overlay's click-away.
                    e.preventDefault();
                    run(cmd);
                  }}
                >
                  <span className="palette-row-title">{cmd.title}</span>
                  {cmd.hint && <kbd className="palette-row-hint">{cmd.hint}</kbd>}
                </div>
              ))}
            </div>
          ))}
          {flat.length === 0 && <div className="palette-empty">No matching actions</div>}
        </div>
      </div>
    </div>
  );
}
