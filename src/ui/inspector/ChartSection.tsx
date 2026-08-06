import { Fragment, useEffect, useRef, useState } from "react";
import { useChartEditStore } from "../../engine/chartEditStore";
import { optionPreviewClip, optionPreviewStill } from "../../engine/optionPreviews";
import { resolveChart } from "../../engine/sceneChart";
import type {
  SceneDoc,
  SceneDocChart,
  SceneDocChartSeries,
  SceneDocChartValueAxis,
  SceneDocChartValueLabels,
} from "../../engine/sceneDocSchema";
import type { Theme } from "../../theme/tokens";
import {
  CHART_ANIMATION_PRESET_IDS,
  CHART_ANIMATION_PRESETS,
  type ChartPresetTier,
  chartPresetFor,
} from "../../toolkit/chart/animation";
import { CHART_DECIMALS_MAX, formatChartValue } from "../../toolkit/chart/format";
import { CHART_PALETTE_SIZE, resolveSeriesColour } from "../../toolkit/chart/palette";
import {
  CHART_PALETTE_SCHEME_IDS,
  CHART_PALETTE_SCHEMES,
} from "../../toolkit/chart/paletteSchemes";
import {
  CHART_STYLE_PRESET_IDS,
  CHART_STYLE_PRESETS,
  type ChartStyleTier,
} from "../../toolkit/chart/stylePresets";
import type {
  ChartAnimationDelivery,
  ChartAnimationFrom,
  ChartCategoryAxis,
  ChartDimension,
  ChartGridlineStyle,
  ChartMount,
  ChartStyle,
  ChartValueFormat,
  ChartValueLabelLocation,
} from "../../toolkit/chart/types";
import type { DevicePlacement } from "../../toolkit/device/Device";
import type { V3 } from "../../toolkit/types";
import { closeChartDataModal, openChartDataModal } from "../chartDataModalStore";
import { ColourPicker } from "../colour/ColourPicker";
import { CHART_TYPE_IDS, CHART_TYPE_LABELS } from "../inspectorOptions";
import { OptionCard } from "../OptionCard";
import { DebouncedRange } from "../TextAnimationPicker";
import {
  ActionRow,
  ChartTypeIcon,
  DrillBack,
  DrillGroup,
  GizmoModeIcon,
  NumberField,
  SegmentedRow,
  ToggleFieldset,
  ToggleRow,
} from "./rows";

/** The chart inspector: the `chart.edit` drill (Graph / Axis / Series, the Keynote split built from the app's own rows) and the `chart.position` placement drill for staged charts. Reads come from `resolveChart` so every control shows the value that renders; writes patch only the field touched, so an untouched default never lands in the sidecar. Live slider and scrub ticks write history-less from a drag-start snapshot and settle to ONE history entry (the video-window pattern). */

/** Tiny stroke glyphs for the Dimension and Mount pills, the SegmentedOption icon slot. */
function DimensionGlyph({ flat = false }: { flat?: boolean }) {
  if (flat) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 1.2 10.5 3.6v4.8L6 10.8 1.5 8.4V3.6L6 1.2Zm0 0v4.6m4.5-2.2L6 5.8M1.5 3.6 6 5.8"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MountGlyph({ mount }: { mount: ChartMount }) {
  if (mount === "hero") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" />
        <path d="M3.5 8.5v-3m2.5 3v-4.6m2.5 4.6v-2" stroke="currentColor" strokeLinecap="round" />
      </svg>
    );
  }
  if (mount === "staged") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M1.5 9.5h9" stroke="currentColor" strokeLinecap="round" />
        <path d="M4 9.5v-4h4v4" stroke="currentColor" strokeLinejoin="round" />
        <path d="M4 5.5 6 4l2 1.5" stroke="currentColor" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" />
      <path d="M4.5 1.5v9" stroke="currentColor" />
    </svg>
  );
}

/** One colour-scheme tile: the six swatches it paints with, over its name. Plain CSS dots, so the picker needs no captured previews. */
function PaletteTile({
  label,
  swatches,
  selected,
  onSelect,
}: {
  label: string;
  swatches: readonly string[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`chart-palette-tile${selected ? " selected" : ""}`}
      title={label}
      onClick={onSelect}
    >
      <span className="chart-palette-swatches" aria-hidden="true">
        {swatches.map((hex, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: six fixed slots that never reorder, and a short theme palette repeats a hex.
          <span key={i} style={{ background: hex }} />
        ))}
      </span>
      {label}
    </button>
  );
}

const CHART_STYLE_TIERS: { id: ChartStyleTier; label: string }[] = [
  { id: "classic", label: "Classic" },
  { id: "studio", label: "Studio" },
  { id: "market", label: "Market" },
];

const CHART_PRESET_TIERS: { id: ChartPresetTier; label: string }[] = [
  { id: "core", label: "Core" },
  { id: "signature", label: "Signature" },
  { id: "market", label: "Market" },
];

const MOUNT_LABELS: Record<ChartMount, string> = {
  hero: "Hero",
  staged: "Staged",
  panel: "Panel",
};

const DELIVERY_OPTIONS: { value: ChartAnimationDelivery; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every mark builds together" },
  { value: "series", label: "Series", title: "One series at a time" },
  { value: "cascade", label: "Cascade", title: "Mark by mark across the chart" },
];

const FROM_OPTIONS: { value: ChartAnimationFrom; label: string }[] = [
  { value: "start", label: "Start" },
  { value: "end", label: "End" },
  { value: "centre", label: "Centre" },
  { value: "edges", label: "Edges" },
  { value: "shuffle", label: "Shuffle" },
];

const GRIDLINE_OPTIONS: { value: ChartGridlineStyle; label: string }[] = [
  { value: "hair", label: "Hairline" },
  { value: "dashed", label: "Dashed" },
  { value: "none", label: "None" },
];

const LABEL_LOCATIONS: { value: ChartValueLabelLocation; label: string }[] = [
  { value: "above", label: "Above" },
  { value: "inside", label: "Inside" },
  { value: "below", label: "Below" },
];

/** Fresh block for the Add-chart entry: the native scaffolder's starter data, byte for byte, so a chart added here and a chart scene start identical. */
export function newChartBlock(): SceneDocChart {
  return {
    type: "column",
    dimension: "3d",
    mount: "hero",
    data: {
      categories: ["April", "May", "June", "July"],
      series: [
        { id: "s1", name: "Region 1", values: [17, 26, 53, 96] },
        { id: "s2", name: "Region 2", values: [55, 43, 70, 58] },
      ],
    },
  };
}

/** A numeric field that also means "auto": empty commits null, and null shows the Auto placeholder (axis min/max). */
function AutoField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setText(value === null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <label className="inspector-pose-field">
      <input
        className="modal-input inspector-num"
        value={text}
        placeholder="Auto"
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value === null ? "" : String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="inspector-pose-caption">{label}</span>
    </label>
  );
}

/** A minus/plus integer stepper. With `auto`, stepping below `min` lands on null and prints "Auto" (the decimals field). */
function StepperRow({
  label,
  value,
  min,
  max,
  auto = false,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  auto?: boolean;
  onChange: (value: number | null) => void;
}) {
  const step = (delta: number) => {
    if (value === null) {
      if (delta > 0) onChange(min);
      return;
    }
    const next = value + delta;
    if (auto && next < min) {
      onChange(null);
      return;
    }
    onChange(Math.min(max, Math.max(min, next)));
  };
  return (
    <div className="popover-row">
      <span className="popover-inline slider-row-label">{label}</span>
      <div className="chart-stepper">
        <button
          type="button"
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={value === null || (!auto && value <= min)}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className="chart-stepper-value">{value === null ? "Auto" : value}</span>
        <button
          type="button"
          aria-label={`More ${label.toLowerCase()}`}
          disabled={value !== null && value >= max}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** A short text field on a labelled row (prefix/suffix, axis names): uncontrolled, committing on blur, so a history entry lands per edit rather than per keystroke. */
function TextRow({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  return (
    <div className="popover-row">
      <span className="popover-inline slider-row-label">{label}</span>
      <input
        key={value}
        className="modal-input"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

/** The shared number-format editor. Axis labels and value labels write the same `ChartValueFormat`, so one component owns decimals, separator, prefix, suffix and compact, and the two editors cannot drift. */
function FormatRows({
  format,
  onChange,
}: {
  format: ChartValueFormat;
  onChange: (patch: Partial<ChartValueFormat>) => void;
}) {
  return (
    <>
      <StepperRow
        label="Decimals"
        value={format.decimals}
        min={0}
        max={CHART_DECIMALS_MAX}
        auto
        onChange={(decimals) => onChange({ decimals })}
      />
      <ToggleRow
        label="Thousands separator"
        checked={format.separator}
        onChange={(separator) => onChange({ separator })}
      />
      <TextRow
        label="Prefix"
        value={format.prefix}
        placeholder="$"
        onCommit={(prefix) => onChange({ prefix })}
      />
      <TextRow
        label="Suffix"
        value={format.suffix}
        placeholder="%"
        onCommit={(suffix) => onChange({ suffix })}
      />
      <ToggleRow
        label="Compact"
        description="Prints 1.2k, 3.4M and 1.2B."
        checked={format.compact}
        onChange={(compact) => onChange({ compact })}
      />
    </>
  );
}

type ChartTab = "graph" | "axis" | "series";

export function ChartDrillIn({
  doc,
  theme,
  hasPanel,
  panelHostsChart,
  backLabel,
  onBack,
  onOpenPosition,
  patchDoc,
  commitFromBaseline,
}: {
  doc: SceneDoc;
  /** The scene's resolved theme: the series swatches show exactly what renders. */
  theme: Theme;
  /** This scene resolves an overlay panel, so the panel mount is offerable. */
  hasPanel: boolean;
  /** That panel already opens a chart slot; without one the panel mount would draw nothing, so picking it opens the slot in the same write. */
  panelHostsChart: boolean;
  backLabel: string;
  onBack: () => void;
  onOpenPosition: () => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const [tab, setTab] = useState<ChartTab>("graph");
  const [axisTab, setAxisTab] = useState<"value" | "category">("value");
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [hoverCard, setHoverCard] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dragBaseline = useRef<SceneDoc | null>(null);
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  const chart = resolveChart(doc);
  if (!chart || !doc.chart) return null;

  const write = (mutate: (c: SceneDocChart) => void, history?: string) =>
    void patchDoc(
      (next) => {
        if (next.chart) mutate(next.chart);
      },
      history ? { history } : undefined,
    );
  const live = (mutate: (c: SceneDocChart) => void) => {
    if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
    void patchDoc(
      (next) => {
        if (next.chart) mutate(next.chart);
      },
      { history: false },
    );
  };
  const commit = (mutate: (c: SceneDocChart) => void, history?: string) => {
    const baseline = dragBaseline.current;
    dragBaseline.current = null;
    if (baseline) {
      void commitFromBaseline(baseline, (next) => {
        if (next.chart) mutate(next.chart);
      });
    } else write(mutate, history);
  };
  const writeStyle = (patch: Partial<ChartStyle>, history?: string) =>
    write((c) => {
      c.style = { ...c.style, ...patch };
    }, history);
  const writeAnimation = (patch: Partial<NonNullable<SceneDocChart["animation"]>>) =>
    write((c) => {
      c.animation = { ...c.animation, ...patch };
    }, "chart build-in");
  const writeValueAxis = (mutate: (a: SceneDocChartValueAxis) => void) =>
    write((c) => {
      const axis = { ...(c.axis?.value ?? {}) };
      mutate(axis);
      c.axis = { ...c.axis, value: axis };
    }, "chart axis");
  const writeCategoryAxis = (mutate: (a: Partial<ChartCategoryAxis>) => void) =>
    write((c) => {
      const category = { ...(c.axis?.category ?? {}) };
      mutate(category);
      c.axis = { ...c.axis, category };
    }, "chart axis");
  const writeValueLabels = (mutate: (l: SceneDocChartValueLabels) => void) =>
    write((c) => {
      const values = { ...(c.labels?.values ?? {}) };
      mutate(values);
      c.labels = { ...c.labels, values };
    }, "chart labels");
  const writeSeries = (mutate: (series: SceneDocChartSeries[]) => void, history?: string) =>
    write((c) => {
      const series = structuredClone(c.data.series);
      mutate(series);
      c.data = { ...c.data, series };
    }, history ?? "chart series");

  const series = chart.data.series;
  const categories = chart.data.categories;
  const dataSummary = `${series.length} series, ${categories.length} categor${
    categories.length === 1 ? "y" : "ies"
  }`;
  const selected = seriesId ? series.find((s) => s.id === seriesId) : undefined;
  const selectedIndex = selected ? series.indexOf(selected) : -1;

  // The detail of a list (the LightEditor pattern): a full screen inside the drill, popped by its own back bar.
  if (selected) {
    const override = doc.chart.data.series.find((s) => s.id === selected.id)?.colour;
    return (
      <div className="inspector-drill chart-drill">
        <DrillBack label="Chart" onClick={() => setSeriesId(null)} />
        <div className="inspector-drill-title">{selected.name}</div>
        <div className="inspector-drill-body inspector-section-body">
          <TextRow
            label="Name"
            value={selected.name}
            onCommit={(name) =>
              writeSeries((rows) => {
                const row = rows.find((s) => s.id === selected.id);
                if (row) row.name = name;
              })
            }
          />
          <DrillGroup
            label="Colour"
            hint="Without an override the chart's colour scheme drives it."
          >
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Series colour</span>
              <ColourPicker
                value={resolveSeriesColour(theme, selectedIndex, override, chart.palette)}
                label={`${selected.name} colour`}
                defaultValue={resolveSeriesColour(theme, selectedIndex, null, chart.palette)}
                onReset={
                  override
                    ? () =>
                        writeSeries((rows) => {
                          const row = rows.find((s) => s.id === selected.id);
                          if (row) delete row.colour;
                        })
                    : undefined
                }
                onCommit={(hex) =>
                  writeSeries((rows) => {
                    const row = rows.find((s) => s.id === selected.id);
                    if (row) row.colour = hex;
                  })
                }
              />
            </div>
            <ActionRow
              label="Clear override"
              chevron={false}
              disabled={!override}
              onClick={() =>
                writeSeries((rows) => {
                  const row = rows.find((s) => s.id === selected.id);
                  if (row) delete row.colour;
                })
              }
            />
          </DrillGroup>
          <DrillGroup label="Values">
            <ul className="chart-values-list">
              {categories.map((category, i) => (
                <li key={category || `c${i}`}>
                  <span>{category || `Category ${i + 1}`}</span>
                  <span>
                    {formatChartValue(selected.values[i] ?? 0, chart.labels.values.format)}
                  </span>
                </li>
              ))}
            </ul>
            <ActionRow
              label="Edit data"
              value={dataSummary}
              chevron
              onClick={() => openChartDataModal()}
            />
          </DrillGroup>
          <ActionRow
            label="Remove series"
            chevron={false}
            danger
            disabled={series.length <= 1}
            onClick={() => {
              setSeriesId(null);
              writeSeries((rows) => {
                const at = rows.findIndex((s) => s.id === selected.id);
                if (at >= 0) rows.splice(at, 1);
              });
            }}
          />
        </div>
      </div>
    );
  }

  const styleIds = (tier: ChartStyleTier) =>
    CHART_STYLE_PRESET_IDS.filter((id) => CHART_STYLE_PRESETS[id].tier === tier);
  const animationIds = (tier: ChartPresetTier) =>
    CHART_ANIMATION_PRESET_IDS.filter((id) => CHART_ANIMATION_PRESETS[id].tier === tier);
  // A block already mounted in a panel keeps the option even if the scene lost its overlay, so the pill always shows the live mount.
  const mountIds: ChartMount[] =
    hasPanel || chart.mount === "panel" ? ["hero", "staged", "panel"] : ["hero", "staged"];
  const mountOptions = mountIds.map((value) => ({
    value,
    label: MOUNT_LABELS[value],
    icon: <MountGlyph mount={value} />,
  }));
  // What the "Theme" tile paints: the swatches this scene's theme resolves, scheme aside.
  const themeSwatches = Array.from({ length: CHART_PALETTE_SIZE }, (_, i) =>
    resolveSeriesColour(theme, i),
  );

  const graph = (
    <>
      <ActionRow
        label="Edit data"
        value={dataSummary}
        chevron
        onClick={() => openChartDataModal()}
      />

      <DrillGroup label="Chart type">
        <div className="bg-type-grid chart-type-grid">
          {CHART_TYPE_IDS.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={chart.type === type}
              className={`bg-type-tile${chart.type === type ? " selected" : ""}`}
              title={CHART_TYPE_LABELS[type]}
              onClick={() =>
                write((c) => {
                  c.type = type;
                }, "chart type")
              }
            >
              <ChartTypeIcon id={type} />
              {CHART_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
        {chart.type === "pie" && (
          <span className="drill-group-hint">
            A pie charts the first series; the rest stay for the other types.
          </span>
        )}
      </DrillGroup>

      {chart.mount !== "panel" && (
        <DrillGroup label="Dimension">
          <SegmentedRow
            options={[
              { value: "2d" as ChartDimension, label: "Flat", icon: <DimensionGlyph flat /> },
              { value: "3d" as ChartDimension, label: "3D", icon: <DimensionGlyph /> },
            ]}
            value={chart.dimension}
            onChange={(dimension) =>
              write((c) => {
                c.dimension = dimension;
              }, "chart dimension")
            }
          />
        </DrillGroup>
      )}

      <DrillGroup
        label="Mount"
        hint={
          hasPanel ? undefined : "Add an overlay to this scene to mount the chart in its panel."
        }
      >
        <SegmentedRow
          className="subtabs-compact"
          options={mountOptions}
          value={chart.mount}
          onChange={(mount) =>
            void patchDoc(
              (next) => {
                if (!next.chart) return;
                next.chart.mount = mount;
                // A panel draws a chart only where its frame opens the slot, so the scene's own override opens it.
                if (mount === "panel" && !panelHostsChart)
                  next.frame = { ...next.frame, chart: {} };
              },
              { history: "chart mount" },
            )
          }
        />
        {chart.mount === "staged" && (
          <ActionRow label="Position" chevron onClick={onOpenPosition} />
        )}
      </DrillGroup>

      <DrillGroup
        label="Appearance"
        hint="A preset restyles the whole chart; the rows below still apply."
      >
        {CHART_STYLE_TIERS.map((tier) => (
          <Fragment key={tier.id}>
            <span className="chart-tier-label">{tier.label}</span>
            <div className="option-grid three-up">
              {styleIds(tier.id).map((id) => (
                <OptionCard
                  key={id}
                  label={CHART_STYLE_PRESETS[id].label}
                  image={optionPreviewStill(`chart-${id}`)}
                  selected={chart.style.preset === id}
                  onSelect={() => writeStyle({ preset: id }, "chart appearance")}
                />
              ))}
            </div>
          </Fragment>
        ))}
      </DrillGroup>

      <DrillGroup
        label="Colours"
        hint="A scheme replaces the theme's chart palette; a per-series colour still wins."
      >
        <div className="chart-palette-grid">
          <PaletteTile
            label="Theme"
            swatches={themeSwatches}
            selected={!chart.palette}
            onSelect={() =>
              write((c) => {
                delete c.palette;
              }, "chart colours")
            }
          />
          {CHART_PALETTE_SCHEME_IDS.map((id) => (
            <PaletteTile
              key={id}
              label={CHART_PALETTE_SCHEMES[id].label}
              swatches={CHART_PALETTE_SCHEMES[id].swatches}
              selected={chart.palette === id}
              onSelect={() =>
                write((c) => {
                  c.palette = id;
                }, "chart colours")
              }
            />
          ))}
        </div>
      </DrillGroup>

      <DrillGroup label="Shape">
        {chart.dimension === "3d" && (
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Depth</span>
            <DebouncedRange
              value={chart.style.depth}
              min={0}
              max={1}
              step={0.01}
              label="Depth"
              onInput={(v) =>
                live((c) => {
                  c.style = { ...c.style, depth: v };
                })
              }
              onCommit={(v) =>
                commit((c) => {
                  c.style = { ...c.style, depth: v };
                }, "chart appearance")
              }
            />
          </div>
        )}
        <div className="popover-row">
          <span className="popover-inline slider-row-label">Corner radius</span>
          <DebouncedRange
            value={chart.style.cornerRadius}
            min={0}
            max={1}
            step={0.01}
            label="Corner radius"
            onInput={(v) =>
              live((c) => {
                c.style = { ...c.style, cornerRadius: v };
              })
            }
            onCommit={(v) =>
              commit((c) => {
                c.style = { ...c.style, cornerRadius: v };
              }, "chart appearance")
            }
          />
        </div>
        <div className="popover-row">
          <span className="popover-inline slider-row-label">Gap</span>
          <DebouncedRange
            value={chart.style.gap}
            min={0}
            max={4}
            step={0.05}
            label="Gap"
            onInput={(v) =>
              live((c) => {
                c.style = { ...c.style, gap: v };
              })
            }
            onCommit={(v) =>
              commit((c) => {
                c.style = { ...c.style, gap: v };
              }, "chart appearance")
            }
          />
        </div>
        {chart.type === "pie" && (
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Inner radius</span>
            <DebouncedRange
              value={chart.style.innerRadius}
              min={0}
              max={0.9}
              step={0.01}
              label="Inner radius"
              onInput={(v) =>
                live((c) => {
                  c.style = { ...c.style, innerRadius: v };
                })
              }
              onCommit={(v) =>
                commit((c) => {
                  c.style = { ...c.style, innerRadius: v };
                }, "chart appearance")
              }
            />
          </div>
        )}
        {chart.mount === "hero" && chart.dimension === "3d" && (
          <div className="inspector-pose-grid">
            <NumberField
              label="tilt x °"
              value={chart.style.rotation[0]}
              decimals={1}
              min={-89}
              max={89}
              onCommit={(n) => writeStyle({ rotation: [n, chart.style.rotation[1]] }, "chart tilt")}
            />
            <NumberField
              label="turn y °"
              value={chart.style.rotation[1]}
              decimals={1}
              min={-180}
              max={180}
              onCommit={(n) => writeStyle({ rotation: [chart.style.rotation[0], n] }, "chart tilt")}
            />
          </div>
        )}
      </DrillGroup>

      {chart.mount === "hero" && (
        <DrillGroup label="Placement" hint="Nudge and size the chart against its fitted pose.">
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Scale</span>
            <DebouncedRange
              value={chart.style.scale}
              min={0.2}
              max={2}
              step={0.01}
              label="Scale"
              onInput={(v) =>
                live((c) => {
                  c.style = { ...c.style, scale: v };
                })
              }
              onCommit={(v) =>
                commit((c) => {
                  c.style = { ...c.style, scale: v };
                }, "chart placement")
              }
            />
          </div>
          <div className="inspector-pose-grid">
            <NumberField
              label="x"
              value={chart.style.offset[0]}
              decimals={2}
              step={0.05}
              min={-20}
              max={20}
              onCommit={(n) =>
                writeStyle({ offset: [n, chart.style.offset[1]] }, "chart placement")
              }
            />
            <NumberField
              label="y"
              value={chart.style.offset[1]}
              decimals={2}
              step={0.05}
              min={-20}
              max={20}
              onCommit={(n) =>
                writeStyle({ offset: [chart.style.offset[0], n] }, "chart placement")
              }
            />
          </div>
        </DrillGroup>
      )}

      <DrillGroup label="Legend">
        <ToggleRow
          label="Show legend"
          checked={chart.labels.legend.visible}
          onChange={(visible) =>
            write((c) => {
              c.labels = { ...c.labels, legend: { ...c.labels?.legend, visible } };
            }, "chart labels")
          }
        />
        <SegmentedRow
          className="subtabs-compact"
          options={[
            { value: "top" as const, label: "Top" },
            { value: "bottom" as const, label: "Bottom" },
            { value: "trailing" as const, label: "Side" },
          ]}
          value={chart.labels.legend.position}
          onChange={(position) =>
            write((c) => {
              c.labels = { ...c.labels, legend: { ...c.labels?.legend, position } };
            }, "chart labels")
          }
        />
      </DrillGroup>

      <DrillGroup label="Build in" hint="How the chart draws itself on when the scene starts.">
        {CHART_PRESET_TIERS.map((tier) => (
          <Fragment key={tier.id}>
            <span className="chart-tier-label">{tier.label}</span>
            <div className="option-grid three-up">
              {animationIds(tier.id).map((id) => {
                const preset = CHART_ANIMATION_PRESETS[id];
                const applied = chartPresetFor(chart.type, id);
                const preview = optionPreviewClip(`chartanim-${id}`);
                return (
                  <OptionCard
                    key={id}
                    label={preset.label}
                    title={
                      applied.id === id
                        ? preset.label
                        : `Falls back to ${applied.label} on a ${CHART_TYPE_LABELS[chart.type].toLowerCase()} chart`
                    }
                    image={preview?.poster ?? optionPreviewStill(`chartanim-${id}`)}
                    clip={preview?.clip}
                    playing={hoverCard === id || chart.animation.preset === id}
                    selected={chart.animation.preset === id}
                    onSelect={() => writeAnimation({ preset: id })}
                    onHoverChange={(h) => setHoverCard((cur) => (h ? id : cur === id ? null : cur))}
                  />
                );
              })}
            </div>
          </Fragment>
        ))}
        <SegmentedRow
          className="subtabs-compact"
          options={DELIVERY_OPTIONS}
          value={chart.animation.delivery}
          onChange={(delivery) => writeAnimation({ delivery })}
        />
        <SegmentedRow
          className="subtabs-compact"
          options={FROM_OPTIONS}
          value={chart.animation.from}
          onChange={(from) => writeAnimation({ from })}
        />
        <div className="inspector-pose-grid">
          <NumberField
            label="stagger ms"
            value={chart.animation.staggerMs}
            decimals={0}
            min={0}
            max={2000}
            step={10}
            dragScale={1}
            onCommit={(staggerMs) => writeAnimation({ staggerMs })}
          />
          <NumberField
            label="duration ms"
            value={chart.animation.durationMs}
            decimals={0}
            min={0}
            max={8000}
            step={50}
            dragScale={5}
            onCommit={(durationMs) => writeAnimation({ durationMs })}
          />
        </div>
      </DrillGroup>
    </>
  );

  const valueAxis = chart.axis.value;
  const categoryAxis = chart.axis.category;
  const axis = (
    <>
      {/* Wrapped so the fieldset's straddle rule cannot lift this pill onto the Graph/Axis/Series control. */}
      <div className="chart-axis-subtabs">
        <SegmentedRow
          className="subtabs-compact"
          options={[
            { value: "value" as const, label: "Value (Y)" },
            { value: "category" as const, label: "Category (X)" },
          ]}
          value={axisTab}
          onChange={setAxisTab}
        />
      </div>
      {axisTab === "value" ? (
        <>
          <ToggleRow
            label="Axis name"
            description="A label alongside the value axis."
            checked={valueAxis.name !== null}
            onChange={(on) =>
              writeValueAxis((a) => {
                a.name = on ? "Value" : null;
              })
            }
          />
          {valueAxis.name !== null && (
            <TextRow
              label="Name"
              value={valueAxis.name}
              placeholder="Value"
              onCommit={(name) =>
                writeValueAxis((a) => {
                  a.name = name;
                })
              }
            />
          )}
          <DrillGroup label="Scale" hint="Empty bounds scale to the data.">
            <div className="inspector-pose-grid">
              <AutoField
                label="min"
                value={valueAxis.min}
                onCommit={(min) =>
                  writeValueAxis((a) => {
                    a.min = min;
                  })
                }
              />
              <AutoField
                label="max"
                value={valueAxis.max}
                onCommit={(max) =>
                  writeValueAxis((a) => {
                    a.max = max;
                  })
                }
              />
            </div>
            <StepperRow
              label="Steps"
              value={valueAxis.steps}
              min={1}
              max={20}
              onChange={(steps) =>
                writeValueAxis((a) => {
                  if (steps !== null) a.steps = steps;
                })
              }
            />
          </DrillGroup>
          <DrillGroup label="Value labels">
            <ToggleRow
              label="Tick labels"
              checked={valueAxis.labels}
              onChange={(labels) =>
                writeValueAxis((a) => {
                  a.labels = labels;
                })
              }
            />
            <FormatRows
              format={valueAxis.format}
              onChange={(patch) =>
                writeValueAxis((a) => {
                  a.format = { ...a.format, ...patch };
                })
              }
            />
          </DrillGroup>
          <DrillGroup label="Gridlines">
            <ToggleRow
              label="Show gridlines"
              checked={valueAxis.gridlines.visible}
              onChange={(visible) =>
                writeValueAxis((a) => {
                  a.gridlines = { ...a.gridlines, visible };
                })
              }
            />
            <SegmentedRow
              className="subtabs-compact"
              options={GRIDLINE_OPTIONS}
              value={valueAxis.gridlines.style}
              onChange={(style) =>
                writeValueAxis((a) => {
                  a.gridlines = { ...a.gridlines, style };
                })
              }
            />
          </DrillGroup>
        </>
      ) : (
        <>
          <ToggleRow
            label="Axis name"
            description="A label alongside the category axis."
            checked={categoryAxis.name !== null}
            onChange={(on) =>
              writeCategoryAxis((a) => {
                a.name = on ? "Category" : null;
              })
            }
          />
          {categoryAxis.name !== null && (
            <TextRow
              label="Name"
              value={categoryAxis.name}
              placeholder="Category"
              onCommit={(name) =>
                writeCategoryAxis((a) => {
                  a.name = name;
                })
              }
            />
          )}
          <ToggleRow
            label="Category labels"
            description="The names under each group."
            checked={categoryAxis.labels}
            onChange={(labels) =>
              writeCategoryAxis((a) => {
                a.labels = labels;
              })
            }
          />
        </>
      )}
    </>
  );

  const values = chart.labels.values;
  const seriesTab = (
    <>
      <DrillGroup label="Series">
        <ul className="chart-series-list">
          {series.map((s, i) => {
            const greyed = chart.type === "pie" && i > 0;
            const override = doc.chart?.data.series.find((row) => row.id === s.id)?.colour;
            return (
              <li key={s.id} className={`chart-series-row${greyed ? " greyed" : ""}`}>
                <ColourPicker
                  value={resolveSeriesColour(theme, i, override, chart.palette)}
                  label={`${s.name} colour`}
                  defaultValue={resolveSeriesColour(theme, i, null, chart.palette)}
                  onReset={
                    override
                      ? () =>
                          writeSeries((rows) => {
                            const row = rows.find((r) => r.id === s.id);
                            if (row) delete row.colour;
                          })
                      : undefined
                  }
                  onCommit={(hex) =>
                    writeSeries((rows) => {
                      const row = rows.find((r) => r.id === s.id);
                      if (row) row.colour = hex;
                    })
                  }
                />
                <input
                  key={s.name}
                  className="chart-series-name"
                  defaultValue={s.name}
                  aria-label={`Series ${i + 1} name`}
                  onBlur={(e) => {
                    if (e.target.value === s.name) return;
                    const name = e.target.value;
                    writeSeries((rows) => {
                      const row = rows.find((r) => r.id === s.id);
                      if (row) row.name = name;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className="chart-series-tools">
                  <button
                    type="button"
                    title="Move up"
                    aria-label={`Move ${s.name} up`}
                    disabled={i === 0}
                    onClick={() =>
                      writeSeries((rows) => {
                        rows.splice(i - 1, 0, ...rows.splice(i, 1));
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label={`Move ${s.name} down`}
                    disabled={i === series.length - 1}
                    onClick={() =>
                      writeSeries((rows) => {
                        rows.splice(i + 1, 0, ...rows.splice(i, 1));
                      })
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title={series.length <= 1 ? "A chart needs one series" : "Remove series"}
                    aria-label={`Remove ${s.name}`}
                    disabled={series.length <= 1}
                    onClick={() =>
                      writeSeries((rows) => {
                        const at = rows.findIndex((r) => r.id === s.id);
                        if (at >= 0) rows.splice(at, 1);
                      })
                    }
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    title="Series options"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => setSeriesId(s.id)}
                  >
                    ›
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <ActionRow
          label="Add series"
          chevron={false}
          onClick={() => {
            const used = new Set(series.map((s) => s.id));
            let n = series.length + 1;
            while (used.has(`s${n}`)) n += 1;
            const id = `s${n}`;
            writeSeries((rows) =>
              rows.push({
                id,
                name: `Series ${rows.length + 1}`,
                values: categories.map(() => 0),
              }),
            );
            setSeriesId(id);
          }}
        />
        {chart.type === "pie" && (
          <span className="drill-group-hint">
            Only the first series draws on a pie; the greyed rows keep their data.
          </span>
        )}
      </DrillGroup>
      <DrillGroup label="Value labels">
        <ToggleRow
          label="Show values"
          checked={values.visible}
          onChange={(visible) =>
            writeValueLabels((l) => {
              l.visible = visible;
            })
          }
        />
        <SegmentedRow
          className="subtabs-compact"
          options={LABEL_LOCATIONS}
          value={values.location}
          onChange={(location) =>
            writeValueLabels((l) => {
              l.location = location;
            })
          }
        />
        <FormatRows
          format={values.format}
          onChange={(patch) =>
            writeValueLabels((l) => {
              l.format = { ...l.format, ...patch };
            })
          }
        />
        <ToggleRow
          label="Count up"
          description="Numbers tick up as their mark builds."
          checked={values.countUp}
          onChange={(countUp) =>
            writeValueLabels((l) => {
              l.countUp = countUp;
            })
          }
        />
      </DrillGroup>
    </>
  );

  return (
    <div className="inspector-drill chart-drill">
      <DrillBack label={backLabel} onClick={onBack} />
      <div className="inspector-drill-title">Chart</div>
      <div className="inspector-drill-body">
        <ToggleFieldset
          control={
            <SegmentedRow
              options={[
                { value: "graph" as const, label: "Graph" },
                { value: "axis" as const, label: "Axis" },
                { value: "series" as const, label: "Series" },
              ]}
              value={tab}
              onChange={setTab}
            />
          }
        >
          {tab === "graph" ? graph : tab === "axis" ? axis : seriesTab}
        </ToggleFieldset>
        <div className="inspector-section-divider" />
        <ActionRow
          label={confirmRemove ? "Really remove?" : "Remove chart"}
          chevron={false}
          danger
          onClick={() => {
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            setConfirmRemove(false);
            closeChartDataModal();
            void patchDoc(
              (next) => {
                next.chart = undefined;
                if (next.animatedTrack === "chart") next.animatedTrack = undefined;
              },
              { history: "remove chart" },
            );
            onBack();
          }}
        />
      </div>
    </div>
  );
}

/** The staged chart's placement drill: the objects-placement idiom (gizmo pills, scrub fields, rest-on-floor), writing the block's `placement`. Scrub ticks preview history-less and settle to one entry on release. */
export function ChartPlacementDrillIn({
  doc,
  backLabel,
  onBack,
  patchDoc,
  commitFromBaseline,
}: {
  doc: SceneDoc;
  backLabel: string;
  onBack: () => void;
  patchDoc: (patch: (next: SceneDoc) => void, opts?: { history?: string | false }) => Promise<void>;
  commitFromBaseline: (baseline: SceneDoc, patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const gizmoMode = useChartEditStore((s) => s.gizmoMode);
  const dragBaseline = useRef<SceneDoc | null>(null);
  if (!doc.chart) return null;

  const placement = doc.chart.placement ?? {};
  const position = placement.position ?? [0, 0, 0];
  const rotationDeg = placement.rotationDeg ?? [0, 0, 0];
  const scale = placement.scale ?? 1;
  const writePlacement = (mutate: (p: DevicePlacement) => void) => (next: SceneDoc) => {
    if (!next.chart) return;
    const p: DevicePlacement = { ...(next.chart.placement ?? {}) };
    mutate(p);
    next.chart.placement = p;
  };
  const live = (mutate: (p: DevicePlacement) => void) => {
    if (!dragBaseline.current) dragBaseline.current = structuredClone(doc);
    void patchDoc(writePlacement(mutate), { history: false });
  };
  const commit = (mutate: (p: DevicePlacement) => void) => {
    const baseline = dragBaseline.current;
    dragBaseline.current = null;
    if (baseline) void commitFromBaseline(baseline, writePlacement(mutate));
    else void patchDoc(writePlacement(mutate), { history: "chart placement" });
  };
  const setAxis = (
    field: "position" | "rotationDeg",
    axis: number,
    value: number,
    settle: boolean,
  ) => {
    const mutate = (p: DevicePlacement) => {
      const current: V3 = [...(field === "position" ? position : rotationDeg)];
      current[axis] = value;
      p[field] = current;
      // An explicit y pins the chart: grounding it again would fight the number just typed.
      if (field === "position" && axis === 1) delete p.ground;
    };
    if (settle) commit(mutate);
    else live(mutate);
  };

  return (
    <div className="inspector-drill chart-drill">
      <DrillBack label={backLabel} onClick={onBack} />
      <div className="inspector-drill-title">Position</div>
      <div className="inspector-drill-body inspector-section-body">
        <DrillGroup label="Gizmo">
          <SegmentedRow
            options={[
              {
                value: "translate" as const,
                label: "Move",
                icon: <GizmoModeIcon mode="translate" />,
              },
              { value: "rotate" as const, label: "Rotate", icon: <GizmoModeIcon mode="rotate" /> },
              { value: "scale" as const, label: "Scale", icon: <GizmoModeIcon mode="scale" /> },
            ]}
            value={gizmoMode}
            onChange={(mode) => useChartEditStore.getState().setGizmoMode(mode)}
          />
          <span className="drill-group-hint">
            Drag the gizmo in the preview; Scale resizes evenly.
          </span>
        </DrillGroup>
        <DrillGroup label="Pose">
          <div className="inspector-pose-grid">
            {(["x", "y", "z"] as const).map((label, axis) => (
              <NumberField
                key={label}
                label={label}
                value={position[axis] ?? 0}
                decimals={2}
                onInput={(n) => setAxis("position", axis, n, false)}
                onCommit={(n) => setAxis("position", axis, n, true)}
              />
            ))}
          </div>
          <div className="inspector-pose-grid">
            {(["tilt x °", "turn y °", "roll z °"] as const).map((label, axis) => (
              <NumberField
                key={label}
                label={label}
                value={rotationDeg[axis] ?? 0}
                decimals={1}
                onInput={(n) => setAxis("rotationDeg", axis, n, false)}
                onCommit={(n) => setAxis("rotationDeg", axis, n, true)}
              />
            ))}
          </div>
          <div className="inspector-pose-grid">
            <NumberField
              label="scale ×"
              value={scale}
              decimals={2}
              min={0.05}
              onInput={(n) =>
                live((p) => {
                  p.scale = Math.max(0.05, n);
                })
              }
              onCommit={(n) =>
                commit((p) => {
                  p.scale = Math.max(0.05, n);
                })
              }
            />
          </div>
        </DrillGroup>
        <ToggleRow
          label="Rest on floor"
          description="Sits the chart's base on the staged floor; inert without one."
          checked={placement.ground ?? false}
          onChange={(on) =>
            commit((p) => {
              if (on) p.ground = true;
              else delete p.ground;
            })
          }
        />
        <ActionRow
          label="Reset position"
          chevron={false}
          onClick={() =>
            commit((p) => {
              p.position = [0, 0, 0];
              p.rotationDeg = [0, 0, 0];
              p.scale = 1;
            })
          }
        />
      </div>
    </div>
  );
}
