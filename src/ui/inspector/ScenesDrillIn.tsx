import { useRef, useState } from "react";
import { moveSelection } from "../../engine/sceneOrder";
import { DrillBack } from "./rows";

/** The Project tab's scene manager: a reorderable multi-select list over the manifest's scenes. macOS list selection (click selects, ⌘ toggles, ⇧ ranges); dragging a selected row moves the whole selection as a block; Duplicate copies the selection after itself. Ops resolve through the host's manifest editors, so this stays presentation + order maths. */

export interface SceneManagerRow {
  index: number;
  name: string;
  durationMs: number;
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
}: {
  scenes: SceneManagerRow[];
  /** An op is in flight; interactions disable rather than queue. */
  busy: boolean;
  onBack: () => void;
  onReorder: (desired: number[]) => void;
  onDuplicate: (indices: number[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
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
    if (busy || e.button !== 0) return;
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
            >
              <span className="scene-manager-grip" aria-hidden>
                ⠿
              </span>
              <span className="scene-manager-name">{scene.name}</span>
              <span className="scene-manager-duration">
                {(scene.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
          ))}
          {drag?.insertBefore !== null && drag && (
            <div
              className="scene-manager-insert"
              style={{ top: `${(drag.insertBefore / Math.max(1, scenes.length)) * 100}%` }}
            />
          )}
        </div>
        <p className="modal-hint">Drag to reorder. ⌘-click to multi-select, ⇧-click for a range.</p>
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
    </div>
  );
}
