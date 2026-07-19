import { useRef, useState } from "react";
import { moveSelection } from "../../engine/sceneOrder";
import { useUiStore } from "../../store/uiStore";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { sceneMenuItems } from "../sceneMenu";
import { DrillBack } from "./rows";

/** The Project tab's scene manager: a reorderable multi-select list over the manifest's scenes. macOS list selection (click selects, ⌘ toggles, ⇧ ranges); dragging a selected row moves the whole selection as a block; Duplicate copies the selection after itself. Double-click renames in place; right-click opens the shared scene menu (the timeline's). Ops resolve through the host's manifest editors, so this stays presentation + order maths. */

export interface SceneManagerRow {
  index: number;
  name: string;
  durationMs: number;
  /** The scene has a sidecar document (rename writes `doc.name`). */
  hasDoc: boolean;
}

interface DragState {
  index: number;
  startY: number;
  /** Insertion point in original-index space (rows.length = the end); null until the drag passes the threshold. */
  insertBefore: number | null;
}

const ROW_DRAG_THRESHOLD_PX = 5;

export function ScenesDrillIn({
  scenes,
  busy,
  onBack,
  onReorder,
  onDuplicate,
  onRename,
  onDuration,
  onDuplicateDialog,
  onCopyBackground,
  onPasteBackground,
  onDelete,
}: {
  scenes: SceneManagerRow[];
  /** An op is in flight; interactions disable rather than queue. */
  busy: boolean;
  onBack: () => void;
  onReorder: (desired: number[]) => void;
  onDuplicate: (indices: number[]) => void;
  /** Commit an in-place rename (the host writes `doc.name` + history). */
  onRename: (index: number, name: string) => void;
  /** Commit a scene length in ms (the host writes project.json + the manual-mode flip). */
  onDuration: (index: number, ms: number) => void;
  /** Open the placement dialog for one scene (the host mounts DuplicateSceneDialog). */
  onDuplicateDialog: (index: number) => void;
  /** Snapshot a scene's background + staging onto the shared clipboard (the host owns the docs). */
  onCopyBackground: (index: number) => void;
  onPasteBackground: (index: number) => void;
  /** Trash-recoverable scene removal (the host reloads; Rust guards the last scene). */
  onDelete: (index: number) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null);
  const [timing, setTiming] = useState<{ index: number; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const select = (index: number, e: React.MouseEvent | React.PointerEvent) => {
    if (e.shiftKey && anchor !== null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      setSelected(new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)));
      return;
    }
    setAnchor(index);
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else {
      setSelected(new Set([index]));
    }
  };

  function insertionFrom(e: React.PointerEvent): number {
    const list = listRef.current;
    if (!list) return 0;
    const rect = list.getBoundingClientRect();
    const rowH = rect.height / Math.max(1, scenes.length);
    const at = Math.round((e.clientY - rect.top) / rowH);
    return Math.min(scenes.length, Math.max(0, at));
  }

  function onRowPointerDown(e: React.PointerEvent, index: number) {
    if (busy || e.button !== 0 || renaming || timing) return;
    e.preventDefault(); // suppress the compatibility mousedown, else the drag sweeps a text selection across the panel
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ index, startY: e.clientY, insertBefore: null });
  }

  function onRowPointerMove(e: React.PointerEvent) {
    if (!drag || busy) return;
    if (drag.insertBefore === null && Math.abs(e.clientY - drag.startY) < ROW_DRAG_THRESHOLD_PX) {
      return;
    }
    // A drag on an unselected row moves just that row.
    if (drag.insertBefore === null && !selected.has(drag.index)) {
      setSelected(new Set([drag.index]));
      setAnchor(drag.index);
    }
    setDrag({ ...drag, insertBefore: insertionFrom(e) });
  }

  function onRowPointerUp(e: React.PointerEvent, index: number) {
    if (!drag) return;
    const { insertBefore } = drag;
    setDrag(null);
    if (insertBefore === null) {
      select(index, e);
      return;
    }
    const block = selected.has(drag.index) ? [...selected].sort((a, b) => a - b) : [drag.index];
    const desired = moveSelection(scenes.length, block, insertBefore);
    if (desired.some((original, i) => original !== i)) {
      setSelected(new Set());
      setAnchor(null);
      onReorder(desired);
    }
  }

  const startRename = (scene: SceneManagerRow) => {
    if (busy || !scene.hasDoc) return;
    setRenaming({ index: scene.index, text: scene.name });
  };

  const finishRename = (commit: boolean) => {
    const r = renaming;
    setRenaming(null);
    if (!commit || !r) return;
    const text = r.text.trim();
    const current = scenes.find((s) => s.index === r.index);
    if (!text || text === current?.name) return;
    onRename(r.index, text);
  };

  const finishTiming = (commit: boolean) => {
    const t = timing;
    setTiming(null);
    if (!commit || !t) return;
    const seconds = Number(t.text);
    // The inspector DurationRow's floor: junk and sub-100ms values are dropped silently.
    if (!Number.isFinite(seconds) || seconds < 0.1) return;
    const ms = Math.round(seconds * 1000);
    const current = scenes.find((s) => s.index === t.index);
    if (ms !== current?.durationMs) onDuration(t.index, ms);
  };

  const openMenu = (e: React.MouseEvent, scene: SceneManagerRow) => {
    if (busy) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: sceneMenuItems({
        canRename: scene.hasDoc,
        lastScene: scenes.length <= 1,
        hasClipboard: !!useUiStore.getState().backgroundClipboard,
        onRename: () => startRename(scene),
        onDuplicate: () => onDuplicateDialog(scene.index),
        onDuration: () =>
          setTiming({ index: scene.index, text: (scene.durationMs / 1000).toFixed(2) }),
        onCopyBackground: () => onCopyBackground(scene.index),
        onPasteBackground: () => onPasteBackground(scene.index),
        onDelete: () => onDelete(scene.index),
      }),
    });
  };

  const selection = [...selected].sort((a, b) => a - b);
  return (
    <div className="inspector-drill">
      <DrillBack label="Project" onClick={onBack} />
      <div className="inspector-drill-title">Scenes</div>
      <div className="inspector-drill-body">
        <div className="scene-manager" ref={listRef} aria-label="Scenes" role="listbox">
          {scenes.map((scene, i) => (
            <div
              key={`${scene.index}:${scene.name}`}
              role="option"
              tabIndex={0}
              aria-selected={selected.has(i)}
              className={`scene-manager-row${selected.has(i) ? " selected" : ""}${
                drag?.insertBefore !== null && drag?.index === i ? " dragging" : ""
              }`}
              onPointerDown={(e) => onRowPointerDown(e, i)}
              onPointerMove={onRowPointerMove}
              onPointerUp={(e) => onRowPointerUp(e, i)}
              onContextMenu={(e) => openMenu(e, scene)}
              onDoubleClick={() => startRename(scene)}
            >
              <span className="scene-manager-grip" aria-hidden>
                ⠿
              </span>
              {renaming?.index === scene.index ? (
                <input
                  className="modal-input scene-manager-edit"
                  value={renaming.text}
                  // biome-ignore lint/a11y/noAutofocus: entered by double-click or the menu, so it IS the focus target
                  autoFocus
                  aria-label="Scene name"
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ index: scene.index, text: e.target.value })}
                  onBlur={() => finishRename(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") finishRename(false);
                  }}
                />
              ) : (
                <span className="scene-manager-name">{scene.name}</span>
              )}
              {timing?.index === scene.index ? (
                <input
                  className="modal-input scene-manager-edit scene-manager-edit-duration"
                  value={timing.text}
                  inputMode="decimal"
                  // biome-ignore lint/a11y/noAutofocus: entered from the context menu, so it IS the focus target
                  autoFocus
                  aria-label="Scene duration in seconds"
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setTiming({ index: scene.index, text: e.target.value })}
                  onBlur={() => finishTiming(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") finishTiming(false);
                  }}
                />
              ) : (
                <span className="scene-manager-duration">
                  {(scene.durationMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          ))}
          {drag?.insertBefore !== null && drag && (
            <div
              className="scene-manager-insert"
              style={{ top: `${(drag.insertBefore / Math.max(1, scenes.length)) * 100}%` }}
            />
          )}
        </div>
        <p className="modal-hint">
          Drag to reorder. ⌘-click to multi-select, ⇧-click for a range. Double-click renames.
        </p>
      </div>
      <div className="inspector-drill-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || selection.length === 0}
          onClick={() => {
            setSelected(new Set());
            setAnchor(null);
            onDuplicate(selection);
          }}
        >
          {busy
            ? "Working…"
            : `Duplicate${selection.length > 1 ? ` ${selection.length} scenes` : ""}`}
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
