import { useCallback, useRef, useState } from "react";
import { parseChartNumber, parseDelimitedRows } from "../toolkit/chart/csv";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { useEscapeClose } from "./useEscapeClose";

/** The chart data grid: header row = categories, first column = series names, numeric cells in between. Keyboard first (arrows, Tab, Enter, type-to-overwrite, Escape reverts the cell), multi-cell TSV/CSV paste from the focused cell, and structure edits from the header context menus or the trailing + affordances. Edits commit on navigate/blur, never per keystroke, so the chart behind the modal updates a cell at a time. */

/** Header row and name column live at -1 in the focus grid; the corner is not focusable. */
const HEADER = -1;

const cellKey = (row: number, col: number): string => `${row}:${col}`;

interface Draft {
  row: number;
  col: number;
  text: string;
}

export interface ChartDataGridProps {
  categories: string[];
  seriesNames: string[];
  /** `[series][category]`, rectangular against `categories`. */
  values: number[][];
  onValueCommit: (seriesIndex: number, categoryIndex: number, value: number) => void;
  /** A pasted block of raw cells, anchored at the focused cell. */
  onPasteCells: (seriesIndex: number, categoryIndex: number, cells: string[][]) => void;
  onRenameCategory: (index: number, name: string) => void;
  onRenameSeries: (index: number, name: string) => void;
  onAddCategory: (at: number) => void;
  onRemoveCategory: (index: number) => void;
  onAddSeries: (at: number) => void;
  onRemoveSeries: (index: number) => void;
  /** Stacked types clamp negatives to zero when they render, so the grid flags them. */
  flagNegatives: boolean;
}

export function ChartDataGrid({
  categories,
  seriesNames,
  values,
  onValueCommit,
  onPasteCells,
  onRenameCategory,
  onRenameSeries,
  onAddCategory,
  onRemoveCategory,
  onAddSeries,
  onRemoveSeries,
  flagNegatives,
}: ChartDataGridProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const cells = useRef(new Map<string, HTMLInputElement>());

  const register = (row: number, col: number) => (el: HTMLInputElement | null) => {
    if (el) cells.current.set(cellKey(row, col), el);
    else cells.current.delete(cellKey(row, col));
  };

  const revert = useCallback(() => {
    setDraft(null);
    setInvalid(null);
  }, []);

  // While a cell holds uncommitted text the grid owns Escape: it registers ON TOP of the modal's own layer, so one Escape reverts the cell and the next closes the modal.
  useEscapeClose(revert, draft !== null);

  /** Write the open draft back. False means the text is not a number: the cell keeps it, flagged. */
  const commit = useCallback((): boolean => {
    if (!draft) return true;
    const text = draft.text;
    if (draft.row === HEADER) {
      onRenameCategory(draft.col, text.trim() || `Category ${draft.col + 1}`);
    } else if (draft.col === HEADER) {
      onRenameSeries(draft.row, text.trim() || `Series ${draft.row + 1}`);
    } else {
      const value = parseChartNumber(text);
      if (value === null) {
        setInvalid(`"${text.trim()}" is not a number`);
        return false;
      }
      onValueCommit(draft.row, draft.col, value);
    }
    setDraft(null);
    setInvalid(null);
    return true;
  }, [draft, onRenameCategory, onRenameSeries, onValueCommit]);

  const focusCell = useCallback(
    (row: number, col: number) => {
      const r = Math.max(HEADER, Math.min(seriesNames.length - 1, row));
      let c = Math.max(HEADER, Math.min(categories.length - 1, col));
      // The corner is not a cell: step past it along whichever axis moved.
      if (r === HEADER && c === HEADER) c = 0;
      const el = cells.current.get(cellKey(r, c));
      el?.focus();
      el?.select();
    },
    [categories.length, seriesNames.length],
  );

  const move = (row: number, col: number, dRow: number, dCol: number) => {
    if (!commit()) return;
    focusCell(row + dRow, col + dCol);
  };

  const onCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const input = e.currentTarget;
    // Sideways arrows navigate until the cell is being typed in, then the caret owns them.
    const typing = draft?.row === row && draft?.col === col;
    const atStart = !typing || (input.selectionStart === 0 && input.selectionEnd === 0);
    const atEnd =
      !typing ||
      (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(row, col, -1, 0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(row, col, 1, 0);
    } else if (e.key === "ArrowLeft" && atStart) {
      e.preventDefault();
      move(row, col, 0, -1);
    } else if (e.key === "ArrowRight" && atEnd) {
      e.preventDefault();
      move(row, col, 0, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      move(row, col, e.shiftKey ? -1 : 1, 0);
    }
  };

  const onCellPaste = (e: React.ClipboardEvent<HTMLInputElement>, row: number, col: number) => {
    if (row === HEADER || col === HEADER) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const block = parseDelimitedRows(text);
    if (block.length === 0) return;
    if (block.length === 1 && block[0].length === 1) return; // one cell: let it type in
    e.preventDefault();
    revert();
    onPasteCells(row, col, block);
  };

  const cellText = (row: number, col: number): string => {
    if (draft && draft.row === row && draft.col === col) return draft.text;
    if (row === HEADER) return categories[col] ?? "";
    if (col === HEADER) return seriesNames[row] ?? "";
    return String(values[row]?.[col] ?? 0);
  };

  const openMenu = (e: React.MouseEvent, items: (ContextMenuItem | "separator")[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const categoryMenu = (index: number) => (e: React.MouseEvent) =>
    openMenu(e, [
      { id: "before", label: "Insert column before", onSelect: () => onAddCategory(index) },
      { id: "after", label: "Insert column after", onSelect: () => onAddCategory(index + 1) },
      "separator",
      {
        id: "delete",
        label: "Delete column",
        danger: true,
        disabled: categories.length <= 1,
        title: "A chart needs at least one category",
        onSelect: () => onRemoveCategory(index),
      },
    ]);

  const seriesMenu = (index: number) => (e: React.MouseEvent) =>
    openMenu(e, [
      { id: "above", label: "Insert series above", onSelect: () => onAddSeries(index) },
      { id: "below", label: "Insert series below", onSelect: () => onAddSeries(index + 1) },
      "separator",
      {
        id: "delete",
        label: "Delete series",
        danger: true,
        disabled: seriesNames.length <= 1,
        title: "A chart needs at least one series",
        onSelect: () => onRemoveSeries(index),
      },
    ]);

  const cellProps = (row: number, col: number) => ({
    ref: register(row, col),
    value: cellText(row, col),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ row, col, text: e.target.value }),
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      if (draft && (draft.row !== row || draft.col !== col)) revert();
      e.target.select();
    },
    onBlur: () => {
      commit();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => onCellKeyDown(e, row, col),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => onCellPaste(e, row, col),
  });

  const flagged = (row: number, col: number): string => {
    if (draft?.row === row && draft?.col === col && invalid) return " invalid";
    if (flagNegatives && (values[row]?.[col] ?? 0) < 0) return " negative";
    return "";
  };

  return (
    <div className="chart-data-scroll">
      <table className="chart-data-grid">
        <thead>
          <tr>
            <th className="chart-data-corner" scope="col">
              <span className="chart-data-corner-label">Series</span>
            </th>
            {categories.map((_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a grid column IS its position
              <th key={c} scope="col" onContextMenu={categoryMenu(c)}>
                <input
                  className="chart-data-cell chart-data-head"
                  aria-label={`Category ${c + 1}`}
                  {...cellProps(HEADER, c)}
                />
              </th>
            ))}
            <th className="chart-data-add-col">
              <button
                type="button"
                className="chart-data-add"
                title="Add a category"
                aria-label="Add a category"
                onClick={() => onAddCategory(categories.length)}
              >
                +
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {seriesNames.map((name, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a grid row IS its position
            <tr key={r}>
              <th scope="row" onContextMenu={seriesMenu(r)}>
                <input
                  className="chart-data-cell chart-data-name"
                  aria-label={`Series ${r + 1} name`}
                  {...cellProps(r, HEADER)}
                />
              </th>
              {categories.map((category, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a grid cell IS its position
                <td key={c}>
                  <input
                    className={`chart-data-cell chart-data-value${flagged(r, c)}`}
                    inputMode="decimal"
                    aria-label={`${name}, ${category}`}
                    title={
                      flagNegatives && (values[r]?.[c] ?? 0) < 0
                        ? "Stacked charts clamp negatives to zero"
                        : undefined
                    }
                    {...cellProps(r, c)}
                  />
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">
              <button
                type="button"
                className="chart-data-add chart-data-add-row"
                onClick={() => onAddSeries(seriesNames.length)}
              >
                + Add series
              </button>
            </th>
            <td colSpan={categories.length + 1} />
          </tr>
        </tfoot>
      </table>
      {invalid && <p className="chart-data-invalid">{invalid}, so that cell has not been saved.</p>}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
