import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DebouncedRange } from "../TextAnimationPicker";
import { segmentedKeyTarget } from "./rows";

export interface BgTypeStripOption<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

/** The fill-type strip: icon-only tabs; arrows move focus, Enter/Space/click selects (selecting can write the doc, so focus never auto-activates). */
export function BgTypeStrip<T extends string>({
  options,
  value,
  onSelect,
  ariaLabel,
  controls,
}: {
  options: readonly BgTypeStripOption<T>[];
  /** null: nothing selected (the side follows its theme or Before). */
  value: T | null;
  onSelect: (id: T) => void;
  ariaLabel: string;
  controls?: string;
}) {
  const [focused, setFocused] = useState<T | null>(null);
  const keyOptions = options.map((o) => ({ value: o.id, label: o.label }));
  const tabStop =
    focused ?? (options.some((o) => o.id === value) ? value : (options[0]?.id ?? null));
  return (
    <div className="bg-type-strip" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          className={`bg-type-strip-tab${value === o.id ? " selected" : ""}`}
          aria-selected={value === o.id}
          aria-controls={controls}
          aria-label={o.label}
          title={o.label}
          tabIndex={o.id === tabStop ? 0 : -1}
          onClick={() => onSelect(o.id)}
          onFocus={() => setFocused(o.id)}
          onBlur={(event) => {
            if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null))
              setFocused(null);
          }}
          onKeyDown={(event) => {
            const next = segmentedKeyTarget(keyOptions, o.id, event.key);
            if (next === null) return;
            event.preventDefault();
            const index = options.findIndex((option) => option.id === next);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              .item(index)
              ?.focus();
          }}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

interface SelectedTile {
  tile: HTMLElement;
  headerHeight: number;
}

function selectedTile(region: HTMLElement): SelectedTile | null {
  const tile = region.querySelector<HTMLElement>('[aria-pressed="true"]');
  if (!tile || tile.offsetParent !== region) return null;
  const header = tile
    .closest(".bg-look-group")
    ?.querySelector<HTMLElement>(".bg-look-group-header");
  return { tile, headerHeight: header?.offsetHeight ?? 0 };
}

function tileVisible(region: HTMLElement, selected: SelectedTile | null): boolean {
  if (!selected) return false;
  const top = selected.tile.offsetTop;
  return (
    top >= region.scrollTop + selected.headerHeight &&
    top + selected.tile.offsetHeight <= region.scrollTop + region.clientHeight
  );
}

function revealTile(region: HTMLElement, selected: SelectedTile) {
  region.scrollTop = Math.max(0, selected.tile.offsetTop - selected.headerHeight);
}

/** Keeps the selected tile in view on selection and when the band shrinks under it (never after the user scrolled it away), by scrollTop alone, never scrollIntoView. */
export function LookBrowser({
  selectedId,
  ariaLabel,
  children,
}: {
  selectedId: string | undefined;
  ariaLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const wasVisible = useRef(false);
  useLayoutEffect(() => {
    const region = ref.current;
    if (!region) return;
    const selected = selectedId === undefined ? null : selectedTile(region);
    if (selected && !tileVisible(region, selected)) revealTile(region, selected);
    wasVisible.current = tileVisible(region, selected);
  }, [selectedId]);
  useLayoutEffect(() => {
    const region = ref.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    let lastHeight = region.clientHeight;
    const observer = new ResizeObserver(() => {
      const shrank = region.clientHeight < lastHeight;
      lastHeight = region.clientHeight;
      const selected = selectedTile(region);
      if (shrank && wasVisible.current && selected && !tileVisible(region, selected))
        revealTile(region, selected);
      wasVisible.current = tileVisible(region, selected);
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);
  return (
    <section
      ref={ref}
      className="bg-look-browser"
      aria-label={ariaLabel}
      onScroll={(event) => {
        wasVisible.current = tileVisible(event.currentTarget, selectedTile(event.currentTarget));
      }}
    >
      {children}
    </section>
  );
}

export function LookGroup({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div className="bg-look-group">
      {name && <div className="bg-look-group-header">{name}</div>}
      <div className="bg-look-grid">{children}</div>
    </div>
  );
}

export function PresetStrip({
  selectedName,
  children,
}: {
  selectedName: string | null;
  children: ReactNode;
}) {
  return (
    <div className="bg-preset-strip">
      <div className="bg-preset-strip-header">
        <span className="bg-preset-strip-title">Presets</span>
        {selectedName && (
          <span className="bg-preset-strip-name" title={selectedName}>
            {selectedName}
          </span>
        )}
      </div>
      <div className="bg-preset-strip-row">{children}</div>
    </div>
  );
}

/** The still is a cover-cropped CSS background, never an <img> in the <button>. */
export function PresetSwatch({
  name,
  image,
  fallback,
  selected,
  onSelect,
}: {
  name: string;
  image: string | null;
  fallback?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`bg-preset-swatch${selected ? " selected" : ""}`}
      title={name}
      aria-label={`Preset ${name}`}
      aria-pressed={selected}
      onClick={onSelect}
      style={{ backgroundImage: image ? `url("${image}")` : undefined, backgroundColor: fallback }}
    />
  );
}

export function PresetDivider() {
  return <span className="bg-preset-divider" aria-hidden="true" />;
}

const SHEET_BAR_HEIGHT = 43;
const SHEET_FULL_HEIGHT = 480;
const LOOK_BROWSER_MIN_HEIGHT = 120;

export function sheetOpenHeight(parentHeight: number, fixedHeight: number): number {
  const room = parentHeight - fixedHeight - LOOK_BROWSER_MIN_HEIGHT;
  return Math.max(SHEET_BAR_HEIGHT, Math.min(SHEET_FULL_HEIGHT, room));
}

function measureSheetOpenHeight(sheet: HTMLElement): number | null {
  const parent = sheet.parentElement;
  if (!parent) return null;
  let fixed = 0;
  for (const child of parent.children) {
    if (child !== sheet && !child.classList.contains("bg-look-browser"))
      fixed += (child as HTMLElement).offsetHeight;
  }
  return sheetOpenHeight(parent.clientHeight, fixed);
}

/** Animates to the measured room rather than a max-height-clamped 480px, so closing on a short panel never stalls. */
export function OptionsSheet({
  open,
  onToggle,
  peek,
  chips,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  peek: string;
  chips: readonly string[];
  children: ReactNode;
}) {
  const bodyId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [openHeight, setOpenHeight] = useState<number | null>(null);
  // Every commit, since the fixed bands beside the sheet come and go with the selection.
  useLayoutEffect(() => {
    if (ref.current) setOpenHeight(measureSheetOpenHeight(ref.current));
  });
  useLayoutEffect(() => {
    const sheet = ref.current;
    const parent = sheet?.parentElement;
    if (!sheet || !parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOpenHeight(measureSheetOpenHeight(sheet)));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const shown = chips.slice(0, 3);
  return (
    <div
      ref={ref}
      className={`bg-options-sheet${open ? " open" : ""}`}
      style={
        openHeight === null
          ? undefined
          : { height: open ? openHeight : undefined, maxHeight: openHeight }
      }
    >
      <button
        type="button"
        className="bg-options-sheet-bar"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <svg
          className="bg-options-sheet-chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6.2 3.8 10.4 8l-4.2 4.2" />
        </svg>
        <span className="bg-options-sheet-title">Options</span>
        <span className="bg-options-sheet-peek">{peek}</span>
        {shown.length > 0 && (
          <span className="bg-options-sheet-chips" aria-hidden="true">
            {shown.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: chips are positional (backing, then slots) and may repeat a colour
              <span key={i} className="bg-options-sheet-chip" style={{ background: c }} />
            ))}
          </span>
        )}
      </button>
      <div id={bodyId} className="bg-options-sheet-body" inert={!open}>
        {children}
      </div>
    </div>
  );
}

export function SheetRow({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`bg-sheet-row${trailing ? " has-trailing" : ""}`}>
      <span className="bg-sheet-label">{label}</span>
      {children}
      {trailing}
    </div>
  );
}

export function SheetColours({
  slots,
}: {
  slots: readonly { key: string; label: string; picker: ReactNode }[];
}) {
  return (
    <div className="bg-sheet-colours">
      <span className="bg-sheet-label">Colours</span>
      {slots.map((s) => (
        <span key={s.key} className="bg-sheet-colour">
          {s.picker}
          <span className="bg-sheet-colour-label">{s.label}</span>
        </span>
      ))}
    </div>
  );
}

export function SheetSlider({
  label,
  ariaLabel,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  // The painted fill follows the thumb mid-drag, ahead of DebouncedRange's debounced commit.
  const [live, setLive] = useState(value);
  useEffect(() => setLive(value), [value]);
  const fill = max > min ? Math.min(1, Math.max(0, (live - min) / (max - min))) : 0;
  const decimals = stepDecimals(step);
  return (
    <div
      className="bg-sheet-slider"
      style={{ "--bg-sheet-fill": fill } as CSSProperties}
      onInput={(event) => {
        const target = event.target as HTMLInputElement;
        if (target.type === "range") setLive(Number(target.value));
      }}
    >
      <span className="bg-sheet-label">{label}</span>
      <span className="bg-sheet-slider-rail" aria-hidden="true">
        <span className="bg-sheet-slider-fill" />
      </span>
      <DebouncedRange
        value={value}
        min={min}
        max={max}
        step={step}
        label={ariaLabel ?? label}
        onCommit={onCommit}
        formatValue={(v) => v.toFixed(decimals)}
      />
    </div>
  );
}

export function SheetDivider() {
  return <hr className="bg-sheet-divider" />;
}

const MAX_STEP_DECIMALS = 6;

/** Decimal places a slider step implies (1 → 0, 0.5 → 1, 0.05 → 2). */
export function stepDecimals(step: number): number {
  const size = Math.abs(step);
  if (!Number.isFinite(size) || size === 0) return 0;
  for (let d = 0; d < MAX_STEP_DECIMALS; d++) {
    const scaled = size * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return MAX_STEP_DECIMALS;
}

export function sheetPeek(parts: {
  backing?: string;
  speed: number;
  zoom?: number;
  param?: { label: string; value: number; step: number };
  /** null: the fill has no stage, so the part is dropped. */
  staging: boolean | null;
}): string {
  const out: string[] = [];
  if (parts.backing) out.push(parts.backing);
  out.push(`Speed ${parts.speed.toFixed(2)}`);
  if (parts.zoom !== undefined) out.push(`Zoom ${parts.zoom.toFixed(2)}`);
  if (parts.param)
    out.push(`${parts.param.label} ${parts.param.value.toFixed(stepDecimals(parts.param.step))}`);
  if (parts.staging !== null) out.push(parts.staging ? "Staging on" : "Staging off");
  return out.join(" · ");
}
