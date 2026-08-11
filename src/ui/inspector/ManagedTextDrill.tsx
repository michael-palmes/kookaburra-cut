import { useEffect, useId, useRef, useState } from "react";
import {
  deriveManagedTextModel,
  type VirtualManagedTextOptions,
  type VirtualManagedTextRegistration,
} from "../../engine/managedText";
import type {
  SceneDoc,
  SceneManagedTextItem,
  SceneManagedTextItemType,
  SceneManagedTextMarker,
  SceneTextAlign,
} from "../../engine/sceneDocSchema";
import {
  applyManagedTextStructuralAction,
  type ConfirmManagedTextTakeover,
  describeManagedTextMotion,
  type ManagedTextStructuralAction,
  managedTextStyleValue,
  performManagedTextStructuralAction,
  setManagedTextAlignment,
  setManagedTextCopy,
  setManagedTextIcon,
  setManagedTextPointCopy,
  setManagedTextStyle,
} from "./managedTextEditorModel";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  InspectorSliderRow,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
} from "./rows";

export interface ManagedTextWriteRequest {
  /** Deterministic preview derived from `baseline`; integrations must not persist it directly. */
  preview: SceneDoc;
  history: string | false;
  /** The document `preview` was derived from. */
  baseline: SceneDoc;
  /** True when the final write must collapse preceding history-free ticks into one undo entry. */
  historyFromBaseline?: boolean;
  /** SceneTab must run this against the queued current document before persistence. */
  applyToCurrent: (current: SceneDoc) => SceneDoc;
}

export type ManagedTextWrite = (
  request: ManagedTextWriteRequest,
) => Promise<boolean | undefined> | boolean | undefined;

export function restoreManagedTextActivatorFocus(
  ref: { current: HTMLElement | null },
  schedule: (callback: () => void) => void = (callback) => {
    window.requestAnimationFrame(callback);
  },
): void {
  const activator = ref.current;
  ref.current = null;
  if (!activator) return;
  schedule(() => {
    if (activator.isConnected) activator.focus({ preventScroll: true });
  });
}

export interface ManagedTextDrillProps {
  doc: SceneDoc;
  registrations?: readonly VirtualManagedTextRegistration[];
  virtualOptions?: VirtualManagedTextOptions;
  /** Re-resolves doc-backed overlay icons when a queued write runs against a newer document. */
  virtualOptionsForDoc?: (doc: SceneDoc) => VirtualManagedTextOptions;
  selectedItemKey?: string | null;
  backLabel?: string;
  onBack: () => void;
  onSelectItem: (itemKey: string | null) => void;
  onOpenMotion: (itemKey: string) => void;
  onEditFont: (itemKey: string) => void;
  onEditColour: (itemKey: string) => void;
  confirmTakeover?: ConfirmManagedTextTakeover;
  writeDoc: ManagedTextWrite;
  recentIcons?: readonly string[];
  resolveIconPreview?: (value: string) => string | undefined;
  onOpenEmoji?: (itemKey: string) => Promise<string | undefined> | string | undefined;
  onChooseImage?: (itemKey: string) => Promise<string | undefined> | string | undefined;
  onIconCommitted?: (value: string) => void;
  alignment?: SceneTextAlign;
  /** Overlay integrations can replace the default `textLayout` alignment write. */
  mutateAlignment?: (doc: SceneDoc, align: SceneTextAlign) => SceneDoc | null;
  /** Overlay integrations can replace the default `headerIcon` legacy write. */
  mutateIcon?: (doc: SceneDoc, itemKey: string, value: string | undefined) => SceneDoc | null;
  notice?: string | null;
  disabled?: boolean;
}

const TYPE_OPTIONS: SegmentedOption<SceneManagedTextItemType>[] = [
  { value: "title", label: "Title", icon: <TextTypeIcon type="title" /> },
  { value: "subtitle", label: "Subtitle", icon: <TextTypeIcon type="subtitle" /> },
  { value: "bullets", label: "Bullets", icon: <TextTypeIcon type="bullets" /> },
  { value: "icon", label: "Icon", icon: <TextTypeIcon type="icon" /> },
];

const ALIGNMENT_OPTIONS: SegmentedOption<SceneTextAlign>[] = [
  { value: "left", label: "Left", icon: <TextAlignmentIcon align="left" /> },
  { value: "center", label: "Centre", icon: <TextAlignmentIcon align="center" /> },
  { value: "right", label: "Right", icon: <TextAlignmentIcon align="right" /> },
];

const MARKERS: readonly { value: SceneManagedTextMarker; label: string; preview: string }[] = [
  { value: "dot", label: "Dot", preview: "•" },
  { value: "dash", label: "Dash", preview: "–" },
  { value: "tick", label: "Tick", preview: "✓" },
  { value: "number", label: "Number", preview: "1." },
  { value: "none", label: "None", preview: "∅" },
];

function TextTypeIcon({ type }: { type: SceneManagedTextItemType }) {
  const glyph =
    type === "title" ? (
      <path d="M3.2 4.2h9.6M8 4.2v8.6" />
    ) : type === "subtitle" ? (
      <path d="M5.2 6.4h5.6M8 6.4v6.2" />
    ) : type === "bullets" ? (
      <>
        <circle cx="3.2" cy="4.6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="3.2" cy="11.4" r="1.1" fill="currentColor" stroke="none" />
        <path d="M6.2 4.6h7.2M6.2 8h7.2M6.2 11.4h5" />
      </>
    ) : (
      <>
        <circle cx="8" cy="8" r="5.6" />
        <circle cx="6.1" cy="6.6" r="0.75" fill="currentColor" stroke="none" />
        <circle cx="9.9" cy="6.6" r="0.75" fill="currentColor" stroke="none" />
        <path d="M5.8 9.4a2.9 2.9 0 0 0 4.4 0" />
      </>
    );

  return (
    <svg
      data-text-type-icon={type}
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
      {glyph}
    </svg>
  );
}

function TextAlignmentIcon({ align }: { align: SceneTextAlign }) {
  const middleLine =
    align === "left" ? "M2.6 8h6.6" : align === "center" ? "M4.7 8h6.6" : "M6.8 8h6.6";

  return (
    <svg
      data-text-alignment-icon={align}
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
      <path d="M2.6 4.4h10.8M2.6 11.6h10.8" />
      <path d={middleLine} />
    </svg>
  );
}

function TextControlIcon({
  type,
}: {
  type: "gap" | "indent" | "motion" | "spacing" | "font" | "colour";
}) {
  const glyph =
    type === "gap" ? (
      <>
        <path d="M3 4h10M3 12h10" />
        <path d="M8 6v4M6.5 7.5 8 6l1.5 1.5M6.5 8.5 8 10l1.5-1.5" />
      </>
    ) : type === "indent" ? (
      <>
        <path d="M6 4h7M6 8h7M6 12h7" />
        <path d="m2.5 6 2 2-2 2" />
      </>
    ) : type === "spacing" ? (
      <>
        <path d="M4 3h9M4 8h9M4 13h9" />
        <path d="M2 4.5v7M1 6l1-1.5L3 6M1 10l1 1.5L3 10" />
      </>
    ) : type === "font" ? (
      <path d="M3 5V3h10v2M8 3v10M5.5 13h5" />
    ) : type === "colour" ? (
      <path d="M8 2.5s4 4.2 4 7a4 4 0 0 1-8 0c0-2.8 4-7 4-7z" />
    ) : (
      <>
        <path d="M3 8h10" />
        <path d="m9.5 4.5 3.5 3.5-3.5 3.5" />
      </>
    );
  return (
    <svg
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
      {glyph}
    </svg>
  );
}

function SmallIcon({ type }: { type: "add" | "grip" | "up" | "down" | "remove" }) {
  const glyph =
    type === "add" ? (
      <path d="M8 3v10M3 8h10" />
    ) : type === "grip" ? (
      <>
        <circle cx="5" cy="4" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="4" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="5" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="11" cy="12" r="0.7" fill="currentColor" stroke="none" />
      </>
    ) : type === "up" ? (
      <path d="m4 10 4-4 4 4" />
    ) : type === "down" ? (
      <path d="m4 6 4 4 4-4" />
    ) : (
      <>
        <path d="M3 4h10M6 4V2.5h4V4M5 6v6M8 6v6M11 6v6" />
        <path d="m4 4 .6 9h6.8l.6-9" />
      </>
    );
  return (
    <svg
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
      {glyph}
    </svg>
  );
}

function itemLabel(type: SceneManagedTextItemType): string {
  return TYPE_OPTIONS.find((option) => option.value === type)?.label ?? "Line";
}

function itemPreview(item: SceneManagedTextItem): string {
  if (item.type === "icon") return item.icon || item.text || "No icon";
  if (item.type === "bullets") {
    return (
      item.points
        ?.map((point) => point.text)
        .filter(Boolean)
        .join(" · ") || "No points"
    );
  }
  return item.text?.trim() || "Empty line";
}

function CopyField({
  value,
  label,
  multiline = false,
  disabled,
  onCommit,
  onReturn,
  inputRef,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  disabled?: boolean;
  onCommit: (value: string) => void;
  onReturn?: (value: string) => void;
  inputRef?: (element: HTMLInputElement | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className="modal-input text-inspector-copy-input"
        aria-label={label}
        value={draft}
        disabled={disabled}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <input
      ref={inputRef}
      className="modal-input text-inspector-copy-input"
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onReturn?.(draft);
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function ManagedTextDrill({
  doc,
  registrations = [],
  virtualOptions = {},
  virtualOptionsForDoc,
  selectedItemKey,
  backLabel = "Scene",
  onBack,
  onSelectItem,
  onOpenMotion,
  onEditFont,
  onEditColour,
  confirmTakeover,
  writeDoc,
  recentIcons = [],
  resolveIconPreview,
  onOpenEmoji,
  onChooseImage,
  onIconCommitted,
  alignment,
  mutateAlignment,
  mutateIcon,
  notice,
  disabled = false,
}: ManagedTextDrillProps) {
  const optionsFor = (source: SceneDoc) => virtualOptionsForDoc?.(source) ?? virtualOptions;
  const model = deriveManagedTextModel(doc, registrations, optionsFor(doc));
  const selected =
    model.items.find((item) => item.key === selectedItemKey) ?? model.items[0] ?? null;
  const resolvedVirtualOptions = optionsFor(doc);
  const legacyIcon = resolvedVirtualOptions.icon ?? doc.headerIcon;
  const legacyIconKey = legacyIcon ? (resolvedVirtualOptions.iconKey ?? "icon") : null;
  const selectedIconNeedsTakeover =
    model.ownership === "authored" && selected?.type === "icon" && selected.key !== legacyIconKey;
  const draggedItem = useRef<string | null>(null);
  const draggedPoint = useRef<string | null>(null);
  const baselines = useRef(new Map<string, SceneDoc>());
  const pointRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pendingPointFocus, setPendingPointFocus] = useState<string | null>(null);
  const copyHeadingId = useId();
  const displayedTextStyle =
    model.textStyle || doc.textStyle ? { ...model.textStyle, ...doc.textStyle } : undefined;
  const displayedDoc = displayedTextStyle ? { ...doc, textStyle: displayedTextStyle } : doc;
  const displayedAlignment = alignment ?? doc.textLayout?.align ?? "center";
  useEffect(() => {
    if (!pendingPointFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const input = pointRefs.current[pendingPointFocus];
      if (!input) return;
      input.focus({ preventScroll: true });
      setPendingPointFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingPointFocus]);

  const runStructural = async (
    action: ManagedTextStructuralAction,
    baseline = doc,
    historyBaseline?: SceneDoc,
  ) => {
    if (disabled) return;
    await performManagedTextStructuralAction({
      doc: baseline,
      registrations,
      virtualOptions: optionsFor(baseline),
      action,
      confirmTakeover,
      commit: async (result, history) => {
        let selectedItemKey = result.selectedItemKey;
        let pointToFocus: string | null = null;
        const succeeded = await writeDoc({
          preview: result.doc,
          history,
          baseline: historyBaseline ?? baseline,
          historyFromBaseline: historyBaseline !== undefined,
          applyToCurrent: (current) => {
            const applied = applyManagedTextStructuralAction(
              current,
              action,
              registrations,
              optionsFor(current),
            );
            if (!applied) return current;
            if (action.type === "add-point") {
              const before = new Set(
                deriveManagedTextModel(current, registrations, optionsFor(current))
                  .items.find((item) => item.key === action.itemKey)
                  ?.points?.map((point) => point.key) ?? [],
              );
              pointToFocus =
                applied.doc.managedText?.items
                  .find((item) => item.key === action.itemKey)
                  ?.points?.find((point) => !before.has(point.key))?.key ?? null;
            }
            selectedItemKey = applied.selectedItemKey;
            return applied.doc;
          },
        });
        if (succeeded !== false) {
          onSelectItem(selectedItemKey);
          if (pointToFocus) setPendingPointFocus(pointToFocus);
        }
      },
    });
  };

  const commitCopy = (item: SceneManagedTextItem, value: string) => {
    if (disabled) return;
    const next = setManagedTextCopy(doc, item.key, value, registrations, optionsFor(doc));
    if (next) {
      void writeDoc({
        preview: next,
        history: "edit text copy",
        baseline: doc,
        applyToCurrent: (current) =>
          setManagedTextCopy(current, item.key, value, registrations, optionsFor(current)) ??
          current,
      });
    }
  };

  const commitPointCopy = (item: SceneManagedTextItem, pointKey: string, value: string) => {
    if (disabled) return;
    const next = setManagedTextPointCopy(
      doc,
      item.key,
      pointKey,
      value,
      registrations,
      optionsFor(doc),
    );
    if (next) {
      void writeDoc({
        preview: next,
        history: "edit bullet copy",
        baseline: doc,
        applyToCurrent: (current) =>
          setManagedTextPointCopy(
            current,
            item.key,
            pointKey,
            value,
            registrations,
            optionsFor(current),
          ) ?? current,
      });
    }
  };

  const commitIcon = (itemKey: string, value: string | undefined) => {
    if (disabled) return;
    const update = (source: SceneDoc) =>
      source.managedText !== undefined || !mutateIcon
        ? setManagedTextIcon(source, itemKey, value, registrations, optionsFor(source))
        : mutateIcon(source, itemKey, value);
    const next = update(doc);
    if (next) {
      void (async () => {
        const succeeded = await writeDoc({
          preview: next,
          history: "change text icon",
          baseline: doc,
          applyToCurrent: (current) => update(current) ?? current,
        });
        if (succeeded !== false && value) onIconCommitted?.(value);
      })();
    }
  };

  const commitAlignment = (align: SceneTextAlign) => {
    if (disabled) return;
    const update = (source: SceneDoc) =>
      mutateAlignment ? mutateAlignment(source, align) : setManagedTextAlignment(source, align);
    const next = update(doc);
    if (!next) return;
    void writeDoc({
      preview: next,
      history: "text alignment",
      baseline: doc,
      applyToCurrent: (current) => update(current) ?? current,
    });
  };

  const styleControl = (
    field: "size" | "x" | "y" | "rotation" | "spacing",
    value: number,
    history: string,
  ) => {
    const baselineKey = `style:${selected?.key ?? ""}:${field}`;
    const write = (nextValue: number, live: boolean) => {
      if (!selected || disabled) return;
      let baseline = baselines.current.get(baselineKey);
      if (live && !baseline) {
        baseline = doc;
        baselines.current.set(baselineKey, baseline);
      }
      baseline ??= doc;
      const next = setManagedTextStyle(baseline, selected.key, field, nextValue);
      if (!next) return;
      const applyToCurrent = (current: SceneDoc) =>
        setManagedTextStyle(current, selected.key, field, nextValue) ?? current;
      if (live) void writeDoc({ preview: next, history: false, baseline, applyToCurrent });
      else {
        baselines.current.delete(baselineKey);
        void writeDoc({
          preview: next,
          history,
          baseline,
          historyFromBaseline: true,
          applyToCurrent,
        });
      }
    };
    return {
      value,
      onInput: (nextValue: number) => write(nextValue, true),
      onCommit: (nextValue: number) => write(nextValue, false),
    };
  };

  const bulletSlider = (field: "pointGap" | "indent") => {
    const baselineKey = `bullet:${selected?.key ?? ""}:${field}`;
    const action = (nextValue: number): ManagedTextStructuralAction =>
      field === "pointGap"
        ? { type: "set-point-gap", itemKey: selected?.key ?? "", pointGap: nextValue }
        : { type: "set-indent", itemKey: selected?.key ?? "", indent: nextValue };
    return {
      onInput: (nextValue: number) => {
        if (!selected || disabled || doc.managedText === undefined) return;
        let baseline = baselines.current.get(baselineKey);
        if (!baseline) {
          baseline = doc;
          baselines.current.set(baselineKey, baseline);
        }
        const result = applyManagedTextStructuralAction(baseline, action(nextValue));
        if (result) {
          void writeDoc({
            preview: result.doc,
            history: false,
            baseline,
            applyToCurrent: (current) =>
              applyManagedTextStructuralAction(current, action(nextValue))?.doc ?? current,
          });
        }
      },
      onCommit: (nextValue: number) => {
        if (!selected || disabled) return;
        const baseline = baselines.current.get(baselineKey) ?? doc;
        baselines.current.delete(baselineKey);
        void runStructural(action(nextValue), baseline, baseline);
      },
    };
  };

  const motionSpec = selected
    ? (doc.textAnimationOverrides?.[selected.key] ??
      model.textAnimationOverrides?.[selected.key] ??
      doc.textAnimation)
    : undefined;
  const hasItemMotion =
    selected !== null &&
    (doc.textAnimationOverrides?.[selected.key] !== undefined ||
      model.textAnimationOverrides?.[selected.key] !== undefined);
  const motionValue = `${describeManagedTextMotion(motionSpec)}${
    hasItemMotion ? " · This line" : " · All lines"
  }`;

  return (
    <div className="inspector-drill text-inspector-drill">
      <DrillBack label={backLabel} title="Text" onClick={onBack} />
      <div className="inspector-drill-scroll text-inspector-scroll">
        {notice && <p className="inspector-error">{notice}</p>}
        <DrillGroup label="Alignment">
          <SegmentedRow
            className="text-inspector-alignment-segments"
            options={ALIGNMENT_OPTIONS}
            value={displayedAlignment}
            onChange={commitAlignment}
          />
        </DrillGroup>
        <section className="text-inspector-copy-sheet" aria-labelledby={copyHeadingId}>
          <div className="text-inspector-section-heading">
            <span id={copyHeadingId} className="drill-group-label">
              Copy
            </span>
            <button
              type="button"
              className="btn small text-inspector-add-line"
              disabled={disabled}
              onClick={() =>
                void runStructural({
                  type: "add-item",
                  itemType: "title",
                  afterKey: selected?.key,
                })
              }
            >
              <SmallIcon type="add" />
              Line
            </button>
          </div>
          {model.items.length === 0 ? (
            <p className="inspector-empty text-inspector-empty">No text lines</p>
          ) : (
            <ol className="text-inspector-line-list">
              {model.items.map((item, index) => {
                const active = item.key === selected?.key;
                return (
                  <li
                    key={item.key}
                    className={`text-inspector-line${active ? " active" : ""}`}
                    draggable={!disabled}
                    onDragStart={(event) => {
                      draggedItem.current = item.key;
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.key);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const itemKey =
                        draggedItem.current ?? event.dataTransfer.getData("text/plain");
                      draggedItem.current = null;
                      if (itemKey && itemKey !== item.key) {
                        void runStructural({ type: "move-item", itemKey, toIndex: index });
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="text-inspector-line-grip"
                      aria-label={`Reorder ${itemLabel(item.type)} line`}
                      disabled={disabled}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowUp" && index > 0) {
                          event.preventDefault();
                          void runStructural({
                            type: "move-item",
                            itemKey: item.key,
                            toIndex: index - 1,
                          });
                        }
                        if (event.key === "ArrowDown" && index < model.items.length - 1) {
                          event.preventDefault();
                          void runStructural({
                            type: "move-item",
                            itemKey: item.key,
                            toIndex: index + 1,
                          });
                        }
                      }}
                    >
                      <SmallIcon type="grip" />
                    </button>
                    <button
                      type="button"
                      className="text-inspector-line-select"
                      aria-pressed={active}
                      onClick={() => onSelectItem(item.key)}
                    >
                      <span className="text-inspector-line-type">{itemLabel(item.type)}</span>
                      <span className="text-inspector-line-preview" title={itemPreview(item)}>
                        {itemPreview(item)}
                      </span>
                    </button>
                    <span className="text-inspector-line-order">
                      <button
                        type="button"
                        aria-label={`Move ${itemLabel(item.type)} line up`}
                        disabled={disabled || index === 0}
                        onClick={() =>
                          void runStructural({
                            type: "move-item",
                            itemKey: item.key,
                            toIndex: index - 1,
                          })
                        }
                      >
                        <SmallIcon type="up" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${itemLabel(item.type)} line down`}
                        disabled={disabled || index === model.items.length - 1}
                        onClick={() =>
                          void runStructural({
                            type: "move-item",
                            itemKey: item.key,
                            toIndex: index + 1,
                          })
                        }
                      >
                        <SmallIcon type="down" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {selected && (
          <>
            <DrillGroup label="Selected line">
              <SegmentedRow
                className="text-inspector-type-segments"
                options={TYPE_OPTIONS}
                value={selected.type}
                onChange={(itemType) =>
                  void runStructural({
                    type: "change-type",
                    itemKey: selected.key,
                    itemType,
                  })
                }
              />
              {(selected.type === "title" || selected.type === "subtitle") && (
                <CopyField
                  value={selected.text ?? ""}
                  label={`${itemLabel(selected.type)} copy`}
                  multiline
                  disabled={disabled}
                  onCommit={(value) => commitCopy(selected, value)}
                />
              )}
              {selected.type === "bullets" && (
                <div className="text-inspector-bullets">
                  <ol className="text-inspector-point-list">
                    {(selected.points ?? []).map((point, pointIndex) => (
                      <li
                        key={point.key}
                        className="text-inspector-point-row"
                        draggable={!disabled}
                        onDragStart={(event) => {
                          draggedPoint.current = point.key;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", point.key);
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const pointKey =
                            draggedPoint.current ?? event.dataTransfer.getData("text/plain");
                          draggedPoint.current = null;
                          if (pointKey && pointKey !== point.key) {
                            void runStructural({
                              type: "move-point",
                              itemKey: selected.key,
                              pointKey,
                              toIndex: pointIndex,
                            });
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="text-inspector-point-grip"
                          aria-label={`Reorder point ${pointIndex + 1}`}
                          disabled={disabled}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowUp" && pointIndex > 0) {
                              event.preventDefault();
                              void runStructural({
                                type: "move-point",
                                itemKey: selected.key,
                                pointKey: point.key,
                                toIndex: pointIndex - 1,
                              });
                            }
                            if (
                              event.key === "ArrowDown" &&
                              pointIndex < (selected.points?.length ?? 0) - 1
                            ) {
                              event.preventDefault();
                              void runStructural({
                                type: "move-point",
                                itemKey: selected.key,
                                pointKey: point.key,
                                toIndex: pointIndex + 1,
                              });
                            }
                          }}
                        >
                          <SmallIcon type="grip" />
                        </button>
                        <CopyField
                          value={point.text}
                          label={`Point ${pointIndex + 1}`}
                          disabled={disabled}
                          inputRef={(element) => {
                            pointRefs.current[point.key] = element;
                          }}
                          onCommit={(value) => commitPointCopy(selected, point.key, value)}
                          onReturn={(afterPointText) =>
                            void runStructural({
                              type: "add-point",
                              itemKey: selected.key,
                              afterPointKey: point.key,
                              afterPointText,
                            })
                          }
                        />
                        <button
                          type="button"
                          className="text-inspector-point-remove"
                          aria-label={`Remove point ${pointIndex + 1}`}
                          disabled={disabled}
                          onClick={() =>
                            void runStructural({
                              type: "remove-point",
                              itemKey: selected.key,
                              pointKey: point.key,
                            })
                          }
                        >
                          <SmallIcon type="remove" />
                        </button>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className="btn small text-inspector-add-point"
                    disabled={disabled}
                    onClick={() => void runStructural({ type: "add-point", itemKey: selected.key })}
                  >
                    <SmallIcon type="add" />
                    Point
                  </button>
                  <fieldset className="text-inspector-marker-fieldset" disabled={disabled}>
                    <legend>Marker</legend>
                    <div className="text-inspector-marker-grid">
                      {MARKERS.map((marker) => (
                        <button
                          key={marker.value}
                          type="button"
                          aria-label={`${marker.label} marker`}
                          aria-pressed={(selected.marker ?? "dot") === marker.value}
                          title={marker.label}
                          onClick={() =>
                            void runStructural({
                              type: "set-marker",
                              itemKey: selected.key,
                              marker: marker.value,
                            })
                          }
                        >
                          {marker.preview}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <InspectorSliderRow
                    icon={<TextControlIcon type="gap" />}
                    label="Point gap"
                    value={selected.pointGap ?? 0.14}
                    min={0}
                    max={1}
                    step={0.01}
                    {...bulletSlider("pointGap")}
                  />
                  <InspectorSliderRow
                    icon={<TextControlIcon type="indent" />}
                    label="Indent"
                    value={selected.indent ?? 0.2}
                    min={0}
                    max={1.5}
                    step={0.01}
                    {...bulletSlider("indent")}
                  />
                </div>
              )}
              {selected.type === "icon" && (
                <div className="text-inspector-icon-editor">
                  <div className="text-inspector-icon-preview" role="img" aria-label="Icon preview">
                    {selected.icon && resolveIconPreview?.(selected.icon) ? (
                      <img src={resolveIconPreview(selected.icon)} alt="" />
                    ) : (
                      <span>{selected.icon || "No icon"}</span>
                    )}
                  </div>
                  {selectedIconNeedsTakeover ? (
                    <div className="text-inspector-icon-takeover">
                      <p className="inspector-stub-note">
                        This icon is controlled by scene code. Take over the text block before
                        changing its source, placement or motion.
                      </p>
                      <button
                        type="button"
                        className="btn small"
                        disabled={disabled}
                        onClick={() =>
                          void runStructural({ type: "take-over", itemKey: selected.key })
                        }
                      >
                        Take over to edit
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="text-inspector-icon-actions">
                        <button
                          type="button"
                          className="btn small"
                          disabled={disabled || !onOpenEmoji}
                          onClick={async () => {
                            const value = await onOpenEmoji?.(selected.key);
                            if (value !== undefined) commitIcon(selected.key, value);
                          }}
                        >
                          All emoji
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={disabled || !onChooseImage}
                          onClick={async () => {
                            const value = await onChooseImage?.(selected.key);
                            if (value !== undefined) commitIcon(selected.key, value);
                          }}
                        >
                          Image…
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={disabled || !selected.icon}
                          onClick={() => commitIcon(selected.key, undefined)}
                        >
                          Clear
                        </button>
                      </div>
                      {recentIcons.length > 0 && (
                        <fieldset className="text-inspector-icon-recents" disabled={disabled}>
                          <legend>Recent</legend>
                          <div className="text-inspector-icon-recent-grid">
                            {recentIcons.map((icon) => (
                              <button
                                key={icon}
                                type="button"
                                aria-label={`Use recent icon ${icon}`}
                                aria-pressed={selected.icon === icon}
                                onClick={() => commitIcon(selected.key, icon)}
                              >
                                {resolveIconPreview?.(icon) ? (
                                  <img src={resolveIconPreview(icon)} alt="" />
                                ) : (
                                  icon
                                )}
                              </button>
                            ))}
                          </div>
                        </fieldset>
                      )}
                    </>
                  )}
                </div>
              )}
            </DrillGroup>

            {selected.type !== "icon" && (
              <DrillGroup label="Style">
                <ActionRow
                  icon={<TextControlIcon type="font" />}
                  label="Font"
                  value={
                    typeof displayedTextStyle?.[`${selected.key}Font`] === "string"
                      ? String(displayedTextStyle[`${selected.key}Font`]).split("@")[0]
                      : "Theme"
                  }
                  disabled={disabled}
                  onClick={() => onEditFont(selected.key)}
                />
                <ActionRow
                  icon={<TextControlIcon type="colour" />}
                  label="Colour"
                  value={
                    typeof displayedTextStyle?.[`${selected.key}Color`] === "string"
                      ? String(displayedTextStyle[`${selected.key}Color`])
                      : "Theme"
                  }
                  disabled={disabled}
                  onClick={() => onEditColour(selected.key)}
                />
              </DrillGroup>
            )}

            {!selectedIconNeedsTakeover && (
              <DrillGroup label="Placement">
                <div className="text-inspector-numeric-grid">
                  <NumberField
                    label="Size %"
                    decimals={0}
                    min={10}
                    max={400}
                    step={1}
                    {...styleControl(
                      "size",
                      managedTextStyleValue(displayedDoc, selected.key, "size") * 100,
                      "text size",
                    )}
                    onInput={(value) =>
                      styleControl("size", value, "text size").onInput(value / 100)
                    }
                    onCommit={(value) =>
                      styleControl("size", value, "text size").onCommit(value / 100)
                    }
                  />
                  <NumberField
                    label="X"
                    decimals={2}
                    min={-10}
                    max={10}
                    step={0.01}
                    {...styleControl(
                      "x",
                      managedTextStyleValue(displayedDoc, selected.key, "x"),
                      "text X position",
                    )}
                  />
                  <NumberField
                    label="Y"
                    decimals={2}
                    min={-10}
                    max={10}
                    step={0.01}
                    {...styleControl(
                      "y",
                      managedTextStyleValue(displayedDoc, selected.key, "y"),
                      "text Y position",
                    )}
                  />
                  <NumberField
                    label="Rotation °"
                    decimals={1}
                    min={-180}
                    max={180}
                    step={0.5}
                    {...styleControl(
                      "rotation",
                      managedTextStyleValue(displayedDoc, selected.key, "rotation"),
                      "text rotation",
                    )}
                  />
                </div>
                {selected.type !== "icon" && (
                  <InspectorSliderRow
                    icon={<TextControlIcon type="spacing" />}
                    label="Spacing"
                    min={0.8}
                    max={2}
                    step={0.05}
                    {...styleControl(
                      "spacing",
                      managedTextStyleValue(displayedDoc, selected.key, "spacing"),
                      "text spacing",
                    )}
                  />
                )}
              </DrillGroup>
            )}

            {!selectedIconNeedsTakeover && (
              <DrillGroup label="Motion">
                <ActionRow
                  icon={<TextControlIcon type="motion" />}
                  label="Text motion"
                  value={motionValue}
                  disabled={disabled}
                  onClick={() => onOpenMotion(selected.key)}
                />
              </DrillGroup>
            )}

            <div className="text-inspector-footer">
              <button
                type="button"
                className="btn"
                disabled={disabled}
                onClick={() =>
                  void runStructural({ type: "duplicate-item", itemKey: selected.key })
                }
              >
                Duplicate
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={disabled}
                onClick={() => void runStructural({ type: "remove-item", itemKey: selected.key })}
              >
                Remove
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
