import { useCallback, useRef, useState } from "react";
import { fsUrl, importMediaBytes } from "../engine/media";
import { type LoadedProject, resolveAssetPath } from "../engine/project";
import type { SceneDoc, SceneDocChart, SceneDocChartSeries } from "../engine/sceneDocSchema";
import {
  type ChartCsvData,
  isChartCsvError,
  parseChartCsv,
  parseChartNumber,
} from "../toolkit/chart/csv";
import type { ChartType } from "../toolkit/chart/types";
import { ChartDataGrid } from "./ChartDataGrid";
import { closeChartDataModal, useChartDataModalStore } from "./chartDataModalStore";
import { useEscapeClose } from "./useEscapeClose";
import { useSceneDocPatch } from "./useSceneDocPatch";

/** The chart data modal: a sheet over the canvas holding the data grid, so the chart behind it redraws as each cell commits. Every edit builds on the block the modal itself last wrote (writes are async, a fast typist must never lose one), goes out through `patchDoc({ history: false })`, and the whole sitting lands as ONE history entry on close via `commitFromBaseline`, so undo after closing reverts the lot. With a data track the key strip picks which snapshot the numbers edit; structure (categories, series) always edits the block and follows into every pose. */

/** Taste limits, not hard ones: past these the chart still renders, it just stops reading well. */
const SOFT_CATEGORIES = 12;
const SOFT_SERIES = 6;

const STACKED_TYPES: ChartType[] = ["stackedColumn", "stackedBar", "stackedArea"];

const isStackedType = (type: ChartType): boolean => STACKED_TYPES.includes(type);

const NOOP = () => {};

const seriesName = (series: SceneDocChartSeries, index: number): string =>
  series.name ?? `Series ${index + 1}`;

/** The block's static values, rectangular against its categories (short rows read as 0). */
function staticMatrix(chart: SceneDocChart): number[][] {
  const width = chart.data.categories.length;
  return chart.data.series.map((s) => {
    const row: number[] = [];
    for (let c = 0; c < width; c++) row.push(Number.isFinite(s.values[c]) ? s.values[c] : 0);
    return row;
  });
}

/** A key's pose stretched onto the block's shape; cells the pose never set fall back to the static datum (the engine's own `normaliseMatrix` rule). */
function poseMatrix(chart: SceneDocChart, keyId: string): number[][] {
  const pose = chart.track?.keys.find((k) => k.id === keyId)?.pose;
  return staticMatrix(chart).map((row, s) =>
    row.map((v, c) => {
      const cell = pose?.values?.[s]?.[c];
      return typeof cell === "number" && Number.isFinite(cell) ? cell : v;
    }),
  );
}

function nextSeriesId(chart: SceneDocChart): string {
  const taken = new Set(chart.data.series.map((s) => s.id));
  let n = chart.data.series.length + 1;
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/** Read a project-relative asset as text through the asset protocol (the workspace root is in its scope). */
async function readAssetText(projectId: string, rel: string): Promise<string> {
  const res = await fetch(fsUrl(resolveAssetPath(projectId, rel)));
  if (!res.ok) throw new Error(`could not read ${rel}`);
  return res.text();
}

export interface ChartDataModalProps {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged?: () => void;
}

/** Mount once beside the other modals: it renders only while the store says open and the scene actually has a chart. */
export function ChartDataModal(props: ChartDataModalProps) {
  const open = useChartDataModalStore((s) => s.open);
  const keyId = useChartDataModalStore((s) => s.keyId);
  const chart = props.project.sceneDocs[props.sceneIndex]?.chart;
  if (!open || !chart) return null;
  return <ChartDataSheet {...props} initialKeyId={keyId} />;
}

function ChartDataSheet({
  project,
  sceneIndex,
  onDocChanged,
  onTimingChanged,
  initialKeyId,
}: ChartDataModalProps & { initialKeyId: string | null }) {
  const { doc, slug, patchDoc, commitFromBaseline, error, setError } = useSceneDocPatch(
    project,
    sceneIndex,
    onDocChanged,
    onTimingChanged ?? NOOP,
  );
  // The doc as it stood when the modal opened: the whole sitting undoes as one step.
  const baseline = useRef<SceneDoc | null>(null);
  if (baseline.current === null && doc) baseline.current = structuredClone(doc);
  // The block as the modal last wrote it. Writes are async, so this (not the doc) is what
  // the next edit builds on and what Done commits.
  const written = useRef<SceneDocChart | null>(null);
  const [live, setLive] = useState<SceneDocChart | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(initialKeyId);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chart = live ?? doc?.chart ?? null;

  const close = useCallback(() => {
    const base = baseline.current;
    const latest = written.current;
    if (base && latest) {
      void commitFromBaseline(base, (next) => {
        next.chart = structuredClone(latest);
      });
    }
    closeChartDataModal();
  }, [commitFromBaseline]);

  useEscapeClose(close);

  /** Every edit: mutate a copy of the last written block, show it at once, write it live with no history entry. */
  const edit = useCallback(
    (mutate: (chart: SceneDocChart) => void) => {
      const base = written.current ?? live ?? doc?.chart;
      if (!base) return;
      const next = structuredClone(base);
      mutate(next);
      written.current = next;
      setLive(next);
      setNotice(null);
      void patchDoc(
        (d) => {
          d.chart = structuredClone(next);
        },
        { history: false },
      );
    },
    [doc, live, patchDoc],
  );

  if (!chart) return null;

  const keys = [...(chart.track?.keys ?? [])].sort((a, b) => a.tMs - b.tMs);
  const activeKeyId = keys.some((k) => k.id === selectedKeyId) ? selectedKeyId : null;
  const categories = chart.data.categories;
  const series = chart.data.series;
  const values = activeKeyId ? poseMatrix(chart, activeKeyId) : staticMatrix(chart);
  const stacked = isStackedType(chart.type);

  /** Write one number into whichever snapshot the strip has selected. */
  const setValue = (s: number, c: number, value: number) =>
    edit((next) => {
      if (activeKeyId) {
        const key = next.track?.keys.find((k) => k.id === activeKeyId);
        if (!key) return;
        const matrix = poseMatrix(next, activeKeyId);
        matrix[s][c] = value;
        key.pose = { values: matrix };
        return;
      }
      const row = next.data.series[s];
      if (!row) return;
      for (let i = row.values.length; i < next.data.categories.length; i++) row.values[i] = 0;
      row.values[c] = value;
    });

  const pasteCells = (s: number, c: number, block: string[][]) =>
    edit((next) => {
      const width = next.data.categories.length;
      const height = next.data.series.length;
      const matrix = activeKeyId ? poseMatrix(next, activeKeyId) : staticMatrix(next);
      for (let r = 0; r < block.length && s + r < height; r++) {
        for (let k = 0; k < block[r].length && c + k < width; k++) {
          const value = parseChartNumber(block[r][k]);
          if (value !== null) matrix[s + r][c + k] = value;
        }
      }
      if (activeKeyId) {
        const key = next.track?.keys.find((k) => k.id === activeKeyId);
        if (key) key.pose = { values: matrix };
        return;
      }
      for (let i = 0; i < next.data.series.length; i++) next.data.series[i].values = matrix[i];
    });

  const addCategory = (at: number) =>
    edit((next) => {
      next.data.categories.splice(at, 0, `Category ${next.data.categories.length + 1}`);
      for (const row of next.data.series) row.values.splice(at, 0, 0);
      for (const key of next.track?.keys ?? []) {
        for (const row of key.pose.values) row.splice(at, 0, 0);
      }
    });

  const removeCategory = (index: number) =>
    edit((next) => {
      if (next.data.categories.length <= 1) return;
      next.data.categories.splice(index, 1);
      for (const row of next.data.series) row.values.splice(index, 1);
      for (const key of next.track?.keys ?? []) {
        for (const row of key.pose.values) row.splice(index, 1);
      }
    });

  const addSeries = (at: number) =>
    edit((next) => {
      const zeros = next.data.categories.map(() => 0);
      next.data.series.splice(at, 0, {
        id: nextSeriesId(next),
        name: `Series ${next.data.series.length + 1}`,
        values: [...zeros],
      });
      for (const key of next.track?.keys ?? []) key.pose.values.splice(at, 0, [...zeros]);
    });

  const removeSeries = (index: number) =>
    edit((next) => {
      if (next.data.series.length <= 1) return;
      next.data.series.splice(index, 1);
      for (const key of next.track?.keys ?? []) key.pose.values.splice(index, 1);
    });

  const applyImport = (parsed: ChartCsvData, source: string) =>
    edit((next) => {
      next.data.categories = [...parsed.categories];
      next.data.series = parsed.series.map((row, i) => {
        const existing = next.data.series[i];
        const entry: SceneDocChartSeries = {
          id: existing?.id ?? `s${i + 1}`,
          name: row.name,
          values: [...row.values],
        };
        if (existing?.colour) entry.colour = existing.colour;
        return entry;
      });
      next.data.source = source;
    });

  const readImport = (text: string, source: string) => {
    const parsed = parseChartCsv(text);
    if (isChartCsvError(parsed)) {
      setNotice(parsed.error);
      return;
    }
    applyImport(parsed, source);
    setNotice(
      `Imported ${parsed.series.length} series across ${parsed.categories.length} columns.`,
    );
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      // Best effort: a copy beside the project is what makes Re-import silent later.
      const rel = slug
        ? await importMediaBytes(slug, file.name, new Uint8Array(await file.arrayBuffer())).catch(
            () => null,
          )
        : null;
      readImport(text, rel ?? file.name);
    } catch (err) {
      setNotice(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reimport = async () => {
    const source = chart.data.source;
    if (!source) return;
    // Only a copy inside the project can be re-read; a bare filename asks for the file again.
    if (!source.startsWith("assets/")) {
      fileInput.current?.click();
      return;
    }
    setBusy(true);
    try {
      readImport(await readAssetText(project.id, source), source);
    } catch (err) {
      setNotice(`Could not re-read ${source}: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const negatives = stacked && values.some((row) => row.some((v) => v < 0));
  const overSoftLimit = categories.length > SOFT_CATEGORIES || series.length > SOFT_SERIES;
  const summary = `${series.length} series, ${categories.length} ${categories.length === 1 ? "category" : "categories"}`;

  return (
    <div
      className="modal-overlay chart-data-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Chart data"
    >
      <div className="modal chart-data-modal">
        <div className="modal-title-row">
          <h2 className="modal-title">Chart data</h2>
          <span className="chart-data-summary">{summary}</span>
          <button type="button" className="modal-close" aria-label="Close" onClick={close} />
        </div>

        {keys.length > 0 && (
          <fieldset className="chart-data-keys" aria-label="Which data snapshot to edit">
            <button
              type="button"
              className={`chip ${activeKeyId === null ? "selected" : ""}`}
              aria-pressed={activeKeyId === null}
              title="The values the chart holds before the first keyframe"
              onClick={() => setSelectedKeyId(null)}
            >
              Static
            </button>
            {keys.map((key, i) => (
              <button
                key={key.id}
                type="button"
                className={`chip ${activeKeyId === key.id ? "selected" : ""}`}
                aria-pressed={activeKeyId === key.id}
                onClick={() => setSelectedKeyId(key.id)}
              >
                {`k${i + 1} · ${(key.tMs / 1000).toFixed(2)}s`}
              </button>
            ))}
          </fieldset>
        )}

        <ChartDataGrid
          categories={categories}
          seriesNames={series.map(seriesName)}
          values={values}
          onValueCommit={setValue}
          onPasteCells={pasteCells}
          onRenameCategory={(index, name) =>
            edit((next) => {
              next.data.categories[index] = name;
            })
          }
          onRenameSeries={(index, name) =>
            edit((next) => {
              const row = next.data.series[index];
              if (row) row.name = name;
            })
          }
          onAddCategory={addCategory}
          onRemoveCategory={removeCategory}
          onAddSeries={addSeries}
          onRemoveSeries={removeSeries}
          flagNegatives={stacked}
        />

        <div className="chart-data-notes">
          {negatives && (
            <p className="chart-data-warn">
              Stacked charts clamp negative values to zero when they render.
            </p>
          )}
          {overSoftLimit && (
            <p className="chart-data-warn">
              {`Charts read best up to ${SOFT_CATEGORIES} categories and ${SOFT_SERIES} series.`}
            </p>
          )}
          {notice && <p className="modal-hint">{notice}</p>}
          {error && <p className="modal-error">{error}</p>}
          {!slug && (
            <p className="modal-hint">
              This project lives outside the workspace, so its data is read only.
            </p>
          )}
        </div>

        <div className="modal-actions chart-data-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="chart-data-file"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => void onFilePicked(e)}
          />
          {chart.data.source && (
            <span className="chart-data-source" title={chart.data.source}>
              {chart.data.source.replace(/^assets\//, "")}
            </span>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy || !slug}
            onClick={() => fileInput.current?.click()}
          >
            Import CSV…
          </button>
          {chart.data.source && (
            <button
              type="button"
              className="btn"
              disabled={busy || !slug}
              onClick={() => void reimport()}
            >
              Re-import
            </button>
          )}
          <button type="button" className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
